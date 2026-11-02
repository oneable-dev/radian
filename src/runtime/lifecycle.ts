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
import type { WorkspaceSource } from "./daemon-protocol.ts";
import {
  daemonPaths,
  privateDirectory,
  runtimeOwned,
  runtimePaths,
  type RuntimePaths,
} from "./storage.ts";
import { readJson, remoteError, transport } from "./transport.ts";
import { fetchSnapshot, RuntimeClient } from "./client.ts";
import { probeSnapshot } from "./snapshot-probe.ts";
import { childCommand, selfLaunch, type SelfLaunch } from "./launch.ts";

export type ConnectOptions = {
  offline?: boolean;
  stateRoot?: string;
  config?: string;
  launch?: SelfLaunch;
  // Activation is independent of SDK-free repository registration.
  start?: boolean;
  register?: boolean;
  // Production workspace launches pass their source so a daemon they start discovers it first.
  source?: WorkspaceSource;
  attachChat?: boolean;
};

/**
 * Asks the shared daemon to adopt `source`, re-read its configuration and rediscover current
 * members. Resolves after the daemon has prepared that catalog; returns its snapshot and any
 * accepted-with-warning notices (discovery, restoration or persistence).
 */
export async function prepareWorkspace(
  source: WorkspaceSource,
  options: ConnectOptions = {},
  attachChat = false,
): Promise<Result<{ snapshot: RuntimeSnapshot; warnings: string[] }, ExpectedError>> {
  const daemon = await ensureSharedDaemon({ ...options, source, attachChat });
  if (!daemon.ok) return daemon;
  if (!daemon.value.capabilities?.includes("workspace-source")) {
    return err(
      new ProtocolError(
        "Running shared daemon predates workspace discovery. Finish its work, then run `radian runtime restart`.",
      ),
    );
  }

  const paths = daemonPaths(options.offline ?? false, options.stateRoot);
  const response = await transport(paths, "/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Radian-Instance": daemon.value.instance },
    body: JSON.stringify({ source, ...(attachChat ? { attachChat: true } : {}) }),
    // Discovery of large roots can take longer than ordinary commands.
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) return response;
  const body = await readJson(response.value);
  if (!body.ok) return body;
  if (!Value.Check(replySchema, body.value)) {
    return err(new ProtocolError("Malformed workspace refresh reply; outcome may be unknown."));
  }
  if (!body.value.ok) return err(remoteError(body.value.error));

  const warnings = body.value.warnings?.map((warning) => warning.message) ?? [];
  const fetched = await fetchSnapshot(paths);
  if (!fetched.ok) return fetched;
  if (!fetched.value || fetched.value.instance !== daemon.value.instance) {
    return err(
      new ConnectionError(
        "RUNTIME_ABSENT",
        "Shared daemon changed while preparing the workspace. Reopen radian.",
      ),
    );
  }

  return ok({ snapshot: fetched.value, warnings });
}

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

export async function connectChatRuntime(
  options: ConnectOptions = {},
): Promise<Result<RuntimeClient, ExpectedError>> {
  const daemon = await ensureSharedDaemon(options);
  if (!daemon.ok) return daemon;
  if (!daemon.value.capabilities?.includes("chat-sessions")) {
    return err(
      new ProtocolError(
        "Running shared daemon predates CHAT. Stop it explicitly before using CHAT.",
      ),
    );
  }
  const paths = daemonPaths(options.offline ?? false, options.stateRoot);
  const registered = await transport(paths, "/chat-config", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Radian-Instance": daemon.value.instance },
    body: JSON.stringify({ config: options.config ? resolve(options.config) : null }),
    signal: AbortSignal.timeout(15000),
  });
  if (!registered.ok) return registered;
  const reply = await readJson(registered.value);
  if (!reply.ok) return reply;
  if (!Value.Check(replySchema, reply.value))
    return err(new ProtocolError("Malformed CHAT configuration reply."));
  if (!reply.value.ok) return err(remoteError(reply.value.error));
  const client = new RuntimeClient(paths, daemon.value);
  const attached = await client.attach();
  if (!attached.ok) {
    await client.disconnect();
    return attached;
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
    const fetched = await probeSnapshot(paths, deadline);
    if (!fetched.ok) return fetched;
    if (fetched.value) {
      const identity = sharedIdentity(fetched.value, options.offline ?? false);
      if (!identity.ok) return identity;
      if (
        !fetched.value.capabilities?.includes("daemon-stopping") &&
        !fetched.value.capabilities?.includes("daemon-starting")
      )
        return identity;
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
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now()))),
    );
  }
  return err(
    new ConnectionError(
      "CONNECTION_TIMEOUT",
      `Shared daemon startup/shutdown has not completed; its outcome is not confirmed. Inspect ${paths.log}; no existing owner was stopped.`,
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
        if (options.attachChat) args.push("--runtime-attach-chat");
        // Implicit default files stay implicit; only explicit selections become flags.
        if (options.source) {
          if (options.source.settings.explicit) args.push("--config", options.source.settings.path);
          if (options.source.workspace.explicit) {
            args.push("--workspace-config", options.source.workspace.path);
          }
          args.push("--runtime-cwd", options.source.cwd);
        }
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
