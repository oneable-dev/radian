import { chmod } from "node:fs/promises";
import {
  capture,
  collectCleanup,
  ConnectionError,
  InputError,
  ProtocolError,
  reportUnexpected,
  SessionError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Repository } from "../workspace/model.ts";
import { RepositoryWatcher } from "../workspace/repository-watcher.ts";
import { acquireRuntime, privateDirectory, RuntimeStore, type RuntimePaths } from "./storage.ts";
import { snapshotEvents } from "./events.ts";
import {
  emptyPreferences,
  errorStatus,
  maxFrameBytes,
  parseCommand,
  protocolVersion,
  wireError,
  type RuntimeManifest,
  type RuntimeSnapshot,
} from "./protocol.ts";
import type { WorkspaceRuntime } from "./service.ts";
import type { AccountManager } from "../accounts/manager.ts";

export function rejected(error: ExpectedError): Response {
  return Response.json({ ok: false, error: wireError(error) }, { status: errorStatus(error) });
}

// A cold repository owns metadata and persistence, but no SDK, editor or terminal resources.
export class RepositoryHost {
  readonly instance = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  private readonly store: RuntimeStore;
  private watcher: RepositoryWatcher | undefined;
  private server: Bun.Server<undefined> | undefined;
  private runtime: WorkspaceRuntime | undefined;
  private activating: Promise<Result<void, ExpectedError>> | undefined;
  private unsubscribe: (() => void) | undefined;
  private warning = "";
  private stopped = false;
  private saving: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));

  private constructor(
    private repository: Repository,
    readonly paths: RuntimePaths,
    private manifest: RuntimeManifest,
    private readonly offline: boolean,
    private readonly stateRoot: string | undefined,
    readonly config: string | undefined,
    private readonly release: () => Promise<void>,
    private readonly requestStop: () => void,
    private readonly activated: () => Promise<Result<void, ExpectedError>>,
    private readonly accounts?: AccountManager,
  ) {
    this.store = new RuntimeStore(paths);
  }

  static async open(
    repository: Repository,
    paths: RuntimePaths,
    offline: boolean,
    stateRoot: string | undefined,
    config: string | undefined,
    requestStop: () => void,
    activated: () => Promise<Result<void, ExpectedError>>,
    accounts?: AccountManager,
  ): Promise<Result<RepositoryHost, ExpectedError>> {
    const prepared = await capture(async () => {
      await privateDirectory(paths.directory);
      return acquireRuntime(paths);
    });
    if (!prepared.ok) return prepared;
    const release = prepared.value;
    if (!release)
      return err(
        new ConnectionError(
          "CONNECTION_FAILED",
          `Repository ${repository.name} is still owned by an existing service. Finish its work and explicitly stop the legacy service; it was not replaced.`,
        ),
      );
    let host: RepositoryHost | undefined,
      ready = false;
    return withCleanup(
      async () => {
        const loaded = await new RuntimeStore(paths).load(repository.id);
        if (!loaded.ok) return loaded;
        const manifest = loaded.value ?? {
          version: protocolVersion,
          repositoryId: repository.id,
          repositories: [repository],
          records: [],
          preferences: structuredClone(emptyPreferences),
        };
        host = new RepositoryHost(
          repository,
          paths,
          manifest,
          offline,
          stateRoot,
          config,
          release,
          requestStop,
          activated,
          accounts,
        );
        host.watcher = new RepositoryWatcher(
          repository,
          (result) => {
            if (host!.stopped) return;
            if (result.ok) {
              host!.repository = result.value;
              host!.warning = "";
            } else
              host!.warning = `Worktree discovery failed [${result.error.code}]: ${result.error.message}. Previous entries were retained.`;
            host!.emit();
          },
          (error) => {
            host!.warning = reportUnexpected(error, "repository catalog");
            host!.emit();
          },
        );
        const watched = await host.watcher.start();
        if (!watched.ok)
          host.warning = `Worktree watching failed [${watched.error.code}]: ${watched.error.message}`;
        const listening = await capture(async () => {
          host!.server = Bun.serve({
            unix: paths.socket,
            fetch: (request) => host!.fetch(request),
          });
          await chmod(paths.socket, 0o600);
        });
        if (!listening.ok) return listening;
        ready = true;
        return ok(host);
      },
      async () => {
        if (ready) return;
        if (host) {
          const result = await host.stop();
          if (!result.ok) throw result.error;
        } else await release();
      },
    );
  }

  get active(): boolean {
    return !!this.runtime;
  }
  get snapshot(): RuntimeSnapshot {
    if (this.runtime) {
      const snapshot = this.runtime.snapshot;
      return this.warning
        ? { ...snapshot, notice: [snapshot.notice, this.warning].filter(Boolean).join(" · ") }
        : snapshot;
    }
    return {
      version: protocolVersion,
      pid: process.pid,
      instance: this.instance,
      repositoryId: this.repository.id,
      mode: this.offline ? "offline" : "live",
      capabilities: ["shared-daemon", "repository-catalog"],
      repositories: [this.repository],
      details: {},
      closingCount: 0,
      preferences: this.manifest.preferences,
      notice: this.warning,
      editors: [],
      terminals: [],
      terminalClosingCount: 0,
    };
  }

  activate(): Promise<Result<void, ExpectedError>> {
    if (this.stopped)
      return Promise.resolve(
        err(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping.")),
      );
    if (this.runtime) return Promise.resolve(ok(undefined));
    this.activating ??= this.openRuntime().finally(() => {
      this.activating = undefined;
    });
    return this.activating;
  }

  private async openRuntime(): Promise<Result<void, ExpectedError>> {
    const { openRepositoryRuntime } = await import("./service.ts");
    const saved = await this.saving;
    if (!saved.ok) return saved;
    const initialized = await capture(() =>
      openRepositoryRuntime(
        this.repository.id,
        this.offline,
        this.instance,
        this.stateRoot,
        this.config,
        this.accounts,
      ),
    );
    if (!initialized.ok) return initialized;
    const opened = initialized.value;
    if (!opened.ok) return opened;
    this.runtime = opened.value;
    this.runtime.setObserved(this.listeners.size > 0);
    this.runtime.onStop = this.requestStop;
    this.unsubscribe = this.runtime.subscribe(() => this.emit());
    await this.watcher?.stop();
    this.watcher = undefined;
    const registered = await this.activated();
    this.warning = registered.ok
      ? ""
      : `Repository activated; registration persistence failed: ${registered.error.message}`;
    this.emit();
    return ok(undefined);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async fetch(request: Request): Promise<Response> {
    try {
      const expected = request.headers.get("X-Radian-Instance"),
        path = new URL(request.url).pathname;
      if (expected && expected !== this.instance)
        return rejected(
          new ProtocolError(
            "Runtime instance changed; refresh the connection before retrying. No action was accepted.",
          ),
        );
      if (path === "/snapshot" && request.method === "GET") return Response.json(this.snapshot);
      if (this.stopped)
        return rejected(new SessionError("RUNTIME_STOPPING", "Shared daemon is stopping."));
      if (path === "/events" && request.method === "GET")
        return snapshotEvents(
          () => this.snapshot,
          (listener) => {
            this.listeners.add(listener);
            this.runtime?.setObserved(true);
            return () => {
              this.listeners.delete(listener);
              this.runtime?.setObserved(this.listeners.size > 0);
            };
          },
        );
      if (path === "/activate" && request.method === "POST") {
        if (expected !== this.instance)
          return rejected(
            new ProtocolError("Activation requires the current repository instance."),
          );
        const activated = await this.activate();
        return activated.ok ? Response.json({ ok: true, value: null }) : rejected(activated.error);
      }
      if (this.activating) {
        const ready = await this.activating;
        if (!ready.ok) return rejected(ready.error);
      }
      if (!this.runtime && path === "/command" && request.method === "POST") {
        if (Number(request.headers.get("content-length")) > maxFrameBytes)
          return rejected(new InputError("Command is too large."));
        const text = await request.clone().text();
        if (Buffer.byteLength(text) > maxFrameBytes)
          return rejected(new InputError("Command is too large."));
        const command = parseCommand(text);
        if (!command.ok) return rejected(command.error);
        // Parsing yields to activation; re-enter the active path instead of writing stale cold state.
        if (this.activating || this.runtime) return this.fetch(request);
        if (command.value.type === "stop") {
          setTimeout(this.requestStop, 20);
          return Response.json({ ok: true, value: null });
        }
        if (command.value.type === "preferences") {
          // The cold catalog has no live tabs; preserve the last runtime's saved order.
          this.manifest = { ...this.manifest, preferences: command.value.preferences };
          this.saving = this.store.save(this.manifest);
          const saved = await this.saving;
          this.warning = saved.ok ? "" : `Runtime persistence failed: ${saved.error.message}`;
          this.emit();
          return Response.json({
            ok: true,
            value: null,
            ...(!saved.ok ? { warnings: [wireError(saved.error)] } : {}),
          });
        }
      }
      // Unknown paths must not allocate an SDK or start a process.
      if (
        ![
          "/command",
          "/accounts",
          "/dashboard",
          "/history",
          "/history/preview",
          "/models",
          "/completions",
          "/completion-catalog",
          "/images",
          "/editor/events",
          "/terminal/events",
        ].includes(path)
      )
        return new Response("Not found", { status: 404 });
      const activated = await this.activate();
      if (!activated.ok) return rejected(activated.error);
      return this.runtime!.fetch(request);
    } catch (error) {
      reportUnexpected(error, "repository request");
      return Response.json(
        {
          ok: false,
          error: {
            code: "REMOTE_INTERNAL_ERROR",
            message:
              "Unexpected repository failure. Inspect the shared daemon log; action outcome may be unknown.",
            outcome: "unknown",
          },
        },
        { status: 500 },
      );
    }
  }

  async stop(): Promise<Result<void, ExpectedError>> {
    if (this.stopped) return ok(undefined);
    this.stopped = true;
    return withCleanup(
      async () => {
        if (this.activating) {
          const result = await this.activating;
          if (!result.ok) this.warning = result.error.message;
        }
        this.unsubscribe?.();
        return collectCleanup(
          [
            this.watcher
              ? this.watcher.stop().then(() => ok(undefined))
              : Promise.resolve(ok(undefined)),
            this.runtime ? this.runtime.stop() : this.store.save(this.manifest),
          ],
          "Repository shutdown failed.",
        );
      },
      async () => {
        await withCleanup(async () => {
          await this.server?.stop(true);
        }, this.release);
      },
    );
  }
}
