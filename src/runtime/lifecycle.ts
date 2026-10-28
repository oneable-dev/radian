import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import {
  capture,
  ConnectionError,
  ProtocolError,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { replySchema, type RuntimeSnapshot } from "./protocol.ts";
import {
  daemonPaths,
  privateDirectory,
  runtimeOwned,
  runtimePaths,
  type RuntimePaths,
} from "./storage.ts";
import { readJson, remoteError, transport } from "./transport.ts";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { childCommand, selfLaunch, type SelfLaunch } from "./launch.ts";

export type ConnectOptions = {
  offline?: boolean;
  stateRoot?: string;
  config?: string;
  launch?: SelfLaunch;
  // Activation is independent of SDK-free repository registration.
  start?: boolean;
  register?: boolean;
};

// This lifecycle facade may start an absent owner. RuntimeClient itself only talks
// to existing endpoints; callers explicitly choose this connector when bootstrapping.
export async function connectRuntime(
  repository: Repository,
  cwd: string,
  options: ConnectOptions = {},
): Promise<Result<RuntimeClient | null, ExpectedError>> {
  const paths = runtimePaths(repository.id, options.offline ?? false, options.stateRoot);
  let fetched = await fetchSnapshot(paths);
  if (!fetched.ok) return fetched;
  if (!fetched.value && options.start === false && !options.register) return ok(null);

  let registrationWarning = "";
  if (
    !fetched.value ||
    (fetched.value.capabilities?.includes("shared-daemon") &&
      (options.register || options.start !== false))
  ) {
    const daemon = await ensureSharedDaemon(options);
    if (!daemon.ok) return daemon;
    const registered = await transport(
      daemonPaths(options.offline ?? false, options.stateRoot),
      "/repositories",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Radian-Instance": daemon.value.instance },
        body: JSON.stringify({
          repositoryId: repository.id,
          cwd,
          ...(options.config ? { config: resolve(options.config) } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!registered.ok) return registered;
    const body = await readJson(registered.value);
    if (!body.ok) return body;
    if (!Value.Check(replySchema, body.value)) {
      return err(
        new ProtocolError(
          "Malformed shared daemon registration reply; registration outcome may be unknown.",
        ),
      );
    }
    if (!body.value.ok) return err(remoteError(body.value.error));

    registrationWarning =
      body.value.warnings
        ?.map((warning) => `Repository registered; ${warning.message}`)
        .join(" · ") ?? "";
    fetched = await fetchSnapshot(paths);
    if (!fetched.ok) return fetched;
    if (!fetched.value) {
      return err(
        new ConnectionError(
          "RUNTIME_ABSENT",
          "Repository endpoint is missing after registration. Reconnect before retrying.",
        ),
      );
    }
  }

  const snapshot = fetched.value;
  if (
    snapshot.repositoryId !== repository.id ||
    snapshot.mode !== (options.offline ? "offline" : "live")
  ) {
    return err(new ProtocolError("Runtime identity does not match this workspace."));
  }
  const client = new RuntimeClient(paths, snapshot, registrationWarning);
  const attached = await client.attach();
  if (!attached.ok) {
    await client.disconnect();
    return attached;
  }
  if (options.start !== false) {
    const activated = await client.activate();
    if (!activated.ok) {
      await client.disconnect();
      return activated;
    }
  }
  return ok(client);
}

export async function ensureSharedDaemon(
  options: ConnectOptions = {},
): Promise<Result<RuntimeSnapshot, ExpectedError>> {
  const paths = daemonPaths(options.offline ?? false, options.stateRoot);
  const deadline = Date.now() + 15000;
  let child: ChildProcess | undefined;
  let attempts = 0;
  while (Date.now() < deadline) {
    const fetched = await fetchSnapshot(paths);
    if (!fetched.ok) return fetched;
    if (fetched.value) {
      const identity = sharedIdentity(fetched.value, options.offline ?? false);
      if (!identity.ok) return identity;
      if (!fetched.value.capabilities?.includes("daemon-stopping")) return identity;
    } else if (!child || child.exitCode !== null) {
      if (child?.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0) {
        return err(
          new ConnectionError(
            "CONNECTION_FAILED",
            `Shared daemon startup failed. Inspect ${paths.log}`,
          ),
        );
      }
      const owned = await runtimeOwned(paths);
      if (!owned.ok) return owned;
      // A repository socket may close before the common owner finishes shutting down.
      // Wait for ownership release rather than registering with a dying owner or losing a launch race.
      if (!owned.value) {
        if (attempts++ >= 4) {
          return err(
            new ConnectionError(
              "CONNECTION_FAILED",
              "Shared daemon ownership changed repeatedly. No existing owner was stopped.",
            ),
          );
        }
        const launched = await launchSharedDaemon(paths, options);
        if (!launched.ok) return launched;
        child = launched.value;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  return err(
    new ConnectionError(
      "CONNECTION_TIMEOUT",
      `Shared daemon startup/shutdown has not completed. Inspect ${paths.log}; no existing owner was stopped.`,
    ),
  );
}

function launchSharedDaemon(
  paths: RuntimePaths,
  options: ConnectOptions,
): Promise<Result<ChildProcess, ExpectedError>> {
  return capture(async () => {
    await privateDirectory(paths.directory);
    const log = await open(paths.log, "a", 0o600);
    return withCleanup(
      async () => {
        const args = ["--runtime-service"];
        if (options.stateRoot) args.push("--state-dir", resolve(options.stateRoot));
        if (options.offline) args.push("--test-runtime");
        const [executable, ...argv] = childCommand(options.launch ?? selfLaunch(), args);
        const child = spawn(executable, argv, {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
        const started = Promise.withResolvers<void>();
        child.once("spawn", () => started.resolve());
        child.once("error", (error) => started.reject(error));
        await started.promise;
        child.unref();
        return child;
      },
      () => log.close(),
    );
  });
}

function sharedIdentity(
  snapshot: RuntimeSnapshot,
  offline: boolean,
): Result<RuntimeSnapshot, ExpectedError> {
  return snapshot.repositoryId === "radian:shared" &&
    snapshot.mode === (offline ? "offline" : "live") &&
    snapshot.capabilities?.includes("shared-daemon")
    ? ok(snapshot)
    : err(new ProtocolError("Shared daemon identity or mode does not match this client."));
}
