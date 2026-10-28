import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import {
  capture,
  collectCleanup,
  InputError,
  parseJson,
  ProtocolError,
  reportUnexpected,
  SessionError,
  StorageError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { discoverRepository } from "../workspace/discovery.ts";
import {
  acquireRuntime,
  daemonPaths,
  privateDirectory,
  runtimePaths,
  type RuntimePaths,
} from "./storage.ts";
import {
  daemonRegistrySchema,
  repositoryRegistrationSchema,
  type DaemonRegistry,
  type RepositoryRegistration,
} from "./daemon-protocol.ts";
import { RepositoryHost, rejected } from "./repository-host.ts";
import { AccountManager } from "../accounts/manager.ts";
import {
  emptyPreferences,
  maxFrameBytes,
  parseCommand,
  protocolVersion,
  type RuntimeSnapshot,
} from "./protocol.ts";

type Entry = { registration: RepositoryRegistration; host: RepositoryHost };

// One owner per user/state-root/mode; all repository endpoints below live in this process.
export async function runRuntime(offline: boolean, stateRoot?: string): Promise<void> {
  const paths = daemonPaths(offline, stateRoot);
  await privateDirectory(paths.directory);

  const release = await acquireRuntime(paths);
  if (!release) {
    return;
  }

  const daemon = new SharedDaemon(paths, offline, stateRoot);
  let server: Bun.Server<undefined> | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();

  daemon.onStop = stop;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await withCleanup(
    async () => {
      const loaded = await daemon.load();
      if (!loaded.ok) {
        throw loaded.error;
      }

      server = Bun.serve({ unix: paths.socket, fetch: (request) => daemon.fetch(request) });
      await chmod(paths.socket, 0o600);
      await daemon.restore();
      await stopped.promise;
    },
    async () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await withCleanup(async () => {
        await withCleanup(
          async () => {
            const result = await daemon.stop();
            if (!result.ok) {
              throw result.error;
            }
          },
          async () => {
            await server?.stop(true);
          },
        );
      }, release);
    },
  );
}

class SharedDaemon {
  readonly instance = crypto.randomUUID();
  onStop: () => void = () => {};

  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Result<RepositoryHost, ExpectedError>>>();
  private saved: DaemonRegistry = { version: 1, repositories: [] };
  private saving: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  private stopped = false;
  private loaded = false;
  private accounts: AccountManager | undefined;
  private warning = "";

  constructor(
    private readonly paths: RuntimePaths,
    private readonly offline: boolean,
    private readonly stateRoot: string | undefined,
  ) {}

  async load(): Promise<Result<void, ExpectedError>> {
    const accounts = await AccountManager.open(this.paths.directory, { offline: this.offline });
    if (!accounts.ok) {
      return accounts;
    }

    this.accounts = accounts.value;

    const read = await capture(() => readFile(this.paths.manifest, "utf8"));
    if (!read.ok) {
      if (read.error instanceof StorageError && read.error.systemCode === "ENOENT") {
        this.loaded = true;

        return ok(undefined);
      }

      return read;
    }

    const json = parseJson(read.value, "shared daemon registry");
    if (!json.ok || !Value.Check(daemonRegistrySchema, json.value)) {
      return err(
        new StorageError("Invalid shared daemon registry. The original file was not overwritten."),
      );
    }

    this.saved = json.value;
    this.loaded = true;

    return ok(undefined);
  }

  async restore(): Promise<void> {
    const registrations = [...this.saved.repositories];
    // Keep unavailable/legacy-owned registrations in the registry for explicit recovery.
    let cursor = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(4, registrations.length) }, async () => {
        while (cursor < registrations.length) {
          const registration = registrations[cursor++]!;
          const result = await this.register(registration);
          if (!result.ok) {
            this.warning = `[${result.error.code}] ${result.error.message}`;
            continue;
          }
          if (registration.active) {
            const activated = await result.value.activate();
            if (!activated.ok) {
              this.warning = `[${activated.error.code}] ${activated.error.message}`;
            }
          }
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        this.warning = reportUnexpected(outcome.reason, "repository recovery");
      }
    }
  }

  private register(
    registration: RepositoryRegistration,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    if (this.stopped) {
      return Promise.resolve(
        err(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping.")),
      );
    }

    const existing = this.entries.get(registration.repositoryId);
    if (existing) {
      return this.matchConfig(existing, registration);
    }

    const pending = this.pending.get(registration.repositoryId);
    if (pending) {
      return pending.then((result) =>
        result.ok
          ? this.matchConfig(this.entries.get(registration.repositoryId)!, registration)
          : result,
      );
    }

    const opening = this.openRepository(registration).finally(() => {
      this.pending.delete(registration.repositoryId);
    });
    this.pending.set(registration.repositoryId, opening);

    return opening;
  }

  private async matchConfig(
    entry: Entry,
    registration: RepositoryRegistration,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    const discovered = await discoverRepository(registration.cwd);
    if (!discovered.ok) {
      return discovered;
    }
    if (discovered.value.id !== registration.repositoryId) {
      return err(
        new ProtocolError(
          "Repository registration identity does not match its Git common directory.",
        ),
      );
    }

    return entry.registration.config === registration.config
      ? ok(entry.host)
      : err(
          new InputError(
            "This repository is already registered with a different settings file. Use the registered file or an isolated --state-dir; its running policy was not changed.",
          ),
        );
  }

  private async openRepository(
    registration: RepositoryRegistration,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    const discovered = await discoverRepository(registration.cwd);
    if (!discovered.ok) {
      return discovered;
    }
    if (discovered.value.id !== registration.repositoryId) {
      return err(
        new ProtocolError(
          "Repository registration identity does not match its Git common directory.",
        ),
      );
    }

    const canonical = { ...registration, cwd: discovered.value.id };
    const opened = await RepositoryHost.open(
      discovered.value,
      runtimePaths(registration.repositoryId, this.offline, this.stateRoot),
      this.offline,
      this.stateRoot,
      registration.config,
      () => this.onStop(),
      () => this.persist(),
      this.accounts,
    );
    if (!opened.ok) {
      return opened;
    }

    this.entries.set(registration.repositoryId, { registration: canonical, host: opened.value });

    return opened;
  }

  private get snapshot(): RuntimeSnapshot {
    const snapshots = [...this.entries.values()].map((entry) => entry.host.snapshot);

    return {
      version: protocolVersion,
      pid: process.pid,
      instance: this.instance,
      repositoryId: "radian:shared",
      mode: this.offline ? "offline" : "live",
      capabilities: ["shared-daemon", ...(this.stopped ? ["daemon-stopping"] : [])],
      repositories: snapshots.flatMap((snapshot) => snapshot.repositories),
      details: Object.assign({}, ...snapshots.map((snapshot) => snapshot.details)),
      preferences: structuredClone(emptyPreferences),
      closingCount: snapshots.reduce((total, snapshot) => total + snapshot.closingCount, 0),
      editors: snapshots.flatMap((snapshot) => snapshot.editors ?? []),
      terminals: snapshots.flatMap((snapshot) => snapshot.terminals ?? []),
      terminalClosingCount: snapshots.reduce(
        (total, snapshot) => total + (snapshot.terminalClosingCount ?? 0),
        0,
      ),
      notice: [this.warning, ...snapshots.map((snapshot) => snapshot.notice)]
        .filter(Boolean)
        .join(" · "),
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/snapshot" && request.method === "GET") {
        return Response.json(this.snapshot);
      }
      if (this.stopped) {
        return rejected(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping."));
      }

      const expected = request.headers.get("X-Radian-Instance");
      if (expected && expected !== this.instance) {
        return rejected(
          new ProtocolError("Shared daemon instance changed. No action was accepted."),
        );
      }
      if (request.method !== "POST" || !["/repositories", "/command"].includes(path)) {
        return new Response("Not found", { status: 404 });
      }
      if (expected !== this.instance) {
        return rejected(new ProtocolError("Current shared daemon identity is required."));
      }
      if (Number(request.headers.get("content-length")) > maxFrameBytes) {
        return rejected(new InputError("Request is too large."));
      }

      const text = await request.text();
      if (Buffer.byteLength(text) > maxFrameBytes) {
        return rejected(new InputError("Request is too large."));
      }
      if (path === "/repositories") {
        const json = parseJson(text, "repository registration");
        if (!json.ok) {
          return rejected(json.error);
        }
        if (!Value.Check(repositoryRegistrationSchema, json.value)) {
          return rejected(new InputError("Malformed repository registration."));
        }

        const registration = {
          ...json.value,
          ...(json.value.config ? { config: resolve(json.value.config) } : {}),
        };
        const registered = await this.register(registration);
        if (!registered.ok) {
          return rejected(registered.error);
        }

        const saved = await this.persist();

        return Response.json({
          ok: true,
          value: null,
          ...(!saved.ok
            ? {
                warnings: [
                  { code: saved.error.code, message: saved.error.message, outcome: "unknown" },
                ],
              }
            : {}),
        });
      }

      const command = parseCommand(text);
      if (!command.ok) {
        return rejected(command.error);
      }
      if (command.value.type !== "stop") {
        return rejected(
          new InputError(
            "The shared endpoint only accepts stop; repository commands require their repository endpoint.",
          ),
        );
      }

      setTimeout(() => this.onStop(), 20);

      return Response.json({ ok: true, value: null });
    } catch (error) {
      reportUnexpected(error, "shared daemon request");

      return Response.json(
        {
          ok: false,
          error: {
            code: "REMOTE_INTERNAL_ERROR",
            message: "Unexpected shared daemon failure. Action outcome may be unknown.",
            outcome: "unknown",
          },
        },
        { status: 500 },
      );
    }
  }

  private persist(): Promise<Result<void, ExpectedError>> {
    const registrations = new Map(
      this.saved.repositories.map((registration) => [registration.repositoryId, registration]),
    );
    for (const { registration, host } of this.entries.values()) {
      registrations.set(registration.repositoryId, {
        ...registration,
        active: host.active || registrations.get(registration.repositoryId)?.active === true,
      });
    }

    this.saved = { version: 1, repositories: [...registrations.values()] };

    const text = JSON.stringify(this.saved);
    this.saving = this.saving.then(() =>
      capture(async () => {
        const temporary = `${this.paths.manifest}.${crypto.randomUUID()}.tmp`;
        await withCleanup(
          async () => {
            await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
            await rename(temporary, this.paths.manifest);
          },
          () => rm(temporary, { force: true }),
        );
      }),
    );

    return this.saving.then((result) => {
      if (!result.ok) {
        this.warning = `Shared daemon registry persistence failed: ${result.error.message}`;
      }

      return result;
    });
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    this.stopped = true;
    await Promise.allSettled(this.pending.values());

    // Persist active intent before any repository releases its resources.
    const saved = this.loaded ? await this.persist() : ok(undefined);
    const stopped = await collectCleanup(
      [Promise.resolve(saved), ...[...this.entries.values()].map((entry) => entry.host.stop())],
      "Shared daemon shutdown failed.",
    );
    const accounts = this.accounts ? await this.accounts.stop() : ok(undefined);

    return collectCleanup(
      [Promise.resolve(stopped), Promise.resolve(accounts)],
      "Shared daemon account shutdown failed.",
    );
  }
}
