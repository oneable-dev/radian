import { InputError, knownError, ProtocolError, PtyError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

// A retained POSIX session leader anchors terminal ownership until cleanup ends.
// It never launches a shell before the parent verifies ownership and opens the gate.
export function runTerminalSupervisor(): Result<void, InputError> {
  const send = process.send?.bind(process);
  if (!send || !process.connected) {
    return err(new InputError("Terminal supervisor requires a parent IPC connection."));
  }

  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});
  let launched = false;
  let frozen = false;
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "freeze") {
      frozen = true;
      send({ type: "frozen" });
      return;
    }
    if (message.type !== "start" || launched || frozen) return;
    launched = true;
    if (
      !("argv" in message) ||
      !Array.isArray(message.argv) ||
      !message.argv.length ||
      !message.argv.every((value: unknown): value is string => typeof value === "string") ||
      !("cwd" in message) ||
      typeof message.cwd !== "string"
    ) {
      send({ type: "failed", expected: true, message: "Invalid terminal launch." });
      return;
    }

    const env = { ...process.env };
    delete env.BUN_INTERNAL_IPC_FD;
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn(message.argv, {
        stdin: 0,
        stdout: 1,
        stderr: 2,
        env,
        cwd: message.cwd,
      });
    } catch (error) {
      console.error("[radian:terminal-supervisor]", error);
      send({
        type: "failed",
        expected: knownError(error) !== undefined,
        message: error instanceof Error ? error.message : "Terminal startup failed.",
        stack: error instanceof Error ? error.stack : undefined,
      });
      return;
    }
    send({ type: "started", pid: child.pid });
    void child.exited.then((code) => send({ type: "exited", code }));
  });
  send({ type: "ready" });
  setInterval(() => {}, 60000);
  return ok(undefined);
}

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  void result.promise.catch(() => {}); // A later lifecycle phase may be the consumer.

  return result;
}

export class TerminalSupervisorHandshake {
  readonly ready = deferred<void>();
  readonly started = deferred<number>();
  readonly frozen = deferred<void>();

  constructor(private readonly exited: (code: number) => void) {}

  receive(message: unknown): void {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      this.fail(new ProtocolError("Invalid terminal supervisor message."));

      return;
    }
    switch (message.type) {
      case "ready":
        this.ready.resolve();
        return;
      case "frozen":
        this.frozen.resolve();
        return;
      case "started":
        if (
          "pid" in message &&
          typeof message.pid === "number" &&
          Number.isSafeInteger(message.pid) &&
          message.pid > 1
        ) {
          this.started.resolve(message.pid);

          return;
        }
        break;
      case "exited":
        if (
          "code" in message &&
          typeof message.code === "number" &&
          Number.isInteger(message.code)
        ) {
          this.exited(message.code);

          return;
        }
        break;
      case "failed": {
        const cause = new Error(
          "message" in message && typeof message.message === "string"
            ? message.message
            : "Terminal supervisor failed.",
        );
        if ("stack" in message && typeof message.stack === "string") {
          cause.stack = message.stack;
        }

        this.started.reject(
          "expected" in message && message.expected === true
            ? new PtyError("PTY_UNAVAILABLE", cause.message, { cause })
            : cause,
        );

        return;
      }
    }

    this.fail(new ProtocolError("Invalid terminal supervisor payload."));
  }

  fail(error: Error): void {
    this.ready.reject(error);
    this.started.reject(error);
    this.frozen.reject(error);
  }
}

export async function terminalSupervisorHandshake<T>(task: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PtyError(
                "PTY_UNAVAILABLE",
                `Terminal ${phase} timed out; no commands will be replayed.`,
              ),
            ),
          4000,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
