import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyError } from "../errors.ts";
import { childCommand, selfLaunch } from "../runtime/launch.ts";
import { TerminalSupervisorHandshake, terminalSupervisorHandshake } from "./terminal-supervisor.ts";

test("Terminal supervisors wait for verified startup and frozen gates reject delayed launches", async () => {
  // Exercise the real internal entrypoint without granting it a shell until ownership is verified.
  const directory = await mkdtemp(join(tmpdir(), "radian-terminal-supervisor-"));
  const marker = join(directory, "unexpected-launch");
  const ready = Promise.withResolvers<void>();
  let frozen = Promise.withResolvers<void>();
  const messages: unknown[] = [];
  const child = Bun.spawn(childCommand(selfLaunch(), ["--terminal-supervisor"]), {
    cwd: directory,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ipc(message: unknown) {
      messages.push(message);
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "ready") ready.resolve();
      if (message.type === "frozen") frozen.resolve();
    },
  });
  try {
    await terminalSupervisorHandshake(ready.promise, "test readiness");
    expect(messages).toEqual([{ type: "ready" }]);
    expect(await Bun.file(marker).exists()).toBe(false);

    // Cleanup seals the launch gate before checking for owned descendants.
    child.send({ type: "freeze" });
    await terminalSupervisorHandshake(frozen.promise, "test freeze");
    frozen = Promise.withResolvers<void>();
    child.send({
      type: "start",
      argv: ["/bin/sh", "-c", 'printf unexpected > "$1"', "sh", marker],
      cwd: directory,
    });
    child.send({ type: "freeze" });
    await terminalSupervisorHandshake(frozen.promise, "test launch barrier");

    expect(messages).toEqual([{ type: "ready" }, { type: "frozen" }, { type: "frozen" }]);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Expected supervisor spawn failures retain causes and keep cleanup handshakes usable", async () => {
  const state = new TerminalSupervisorHandshake(() => {});
  state.receive({
    type: "failed",
    expected: true,
    message: "Permission denied",
    stack: "remote spawn stack",
  });

  const error = await state.started.promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PtyError);
  expect((error as PtyError).cause).toBeInstanceOf(Error);
  expect(((error as PtyError).cause as Error).stack).toBe("remote spawn stack");
  state.receive({ type: "frozen" });
  await state.frozen.promise;
});

test("Supervisor programming bugs never become expected input errors", async () => {
  const state = new TerminalSupervisorHandshake(() => {});
  state.receive({
    type: "failed",
    expected: false,
    message: "unexpected defect",
    stack: "original remote stack",
  });

  const error = await state.started.promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(PtyError);
  expect((error as Error).stack).toBe("original remote stack");
});
