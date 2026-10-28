import { ProtocolError, PtyError } from "../errors.ts";

// A retained, isolated session leader prevents session/PID identity reuse while
// background jobs remain. Launch is gated until the parent verifies ownership.
// This trusted source is passed to Bun, never interpolated with shell/user text.
export const shellSupervisorSource = String.raw`
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
let launched = false, frozen = false;
process.on('message', message => {
  if (message?.type === 'freeze') { frozen = true; process.send({ type: 'frozen' }); return; }
  if (message?.type !== 'start' || launched || frozen) return;
  launched = true;
  try {
    if (!Array.isArray(message.argv) || !message.argv.length || !message.argv.every(value => typeof value === 'string') || typeof message.cwd !== 'string') throw new Error('Invalid shell launch');
    const env = { ...process.env };
    delete env.BUN_INTERNAL_IPC_FD; delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    const child = Bun.spawn(message.argv, { stdin: 0, stdout: 1, stderr: 2, env, cwd: message.cwd });
    process.send({ type: 'started', pid: child.pid });
    child.exited.then(code => process.send({ type: 'exited', code }));
  } catch (error) {
    console.error('[radian:shell-supervisor]', error);
    const expected = ['ENOENT','EACCES','EPERM','ENOTDIR','EMFILE','ENFILE','EAGAIN','ENOMEM'].includes(error?.code);
    process.send({ type: 'failed', expected, message: error instanceof Error ? error.message : 'Shell startup failed', stack: error instanceof Error ? error.stack : undefined });
  }
});
process.send({ type: 'ready' });
setInterval(() => {}, 60000);
`;

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  void result.promise.catch(() => {}); // A later lifecycle phase may be the consumer.

  return result;
}

export class ShellHandshake {
  readonly ready = deferred<void>();
  readonly started = deferred<number>();
  readonly frozen = deferred<void>();

  constructor(private readonly exited: (code: number) => void) {}

  receive(message: unknown): void {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      this.fail(new ProtocolError("Invalid shell supervisor message."));

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
            : "Shell supervisor failed.",
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

    this.fail(new ProtocolError("Invalid shell supervisor payload."));
  }

  fail(error: Error): void {
    this.ready.reject(error);
    this.started.reject(error);
    this.frozen.reject(error);
  }
}

export async function shellHandshake<T>(task: Promise<T>, phase: string): Promise<T> {
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
                `Shell ${phase} timed out; no commands will be replayed.`,
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
