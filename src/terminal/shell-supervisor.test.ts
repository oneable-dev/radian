import { expect, test } from "bun:test";
import { PtyError } from "../errors.ts";
import { ShellHandshake } from "./shell-supervisor.ts";

test("Expected supervisor spawn failures retain causes and keep cleanup handshakes usable", async () => {
  const state = new ShellHandshake(() => {});
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
  const state = new ShellHandshake(() => {});
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
