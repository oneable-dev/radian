import { expect, test } from "bun:test";
import { PtyError } from "../errors.ts";
import { ShellHandshake } from "./shell-supervisor.ts";

test("supervisor의 예상된 spawn 실패는 원인을 보존하고 cleanup handshake는 계속 사용할 수 있다", async () => {
  const state = new ShellHandshake(() => {});
  state.receive({ type: "failed", expected: true, message: "Permission denied", stack: "remote spawn stack" });
  const error = await state.started.promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PtyError);
  expect((error as PtyError).cause).toBeInstanceOf(Error);
  expect(((error as PtyError).cause as Error).stack).toBe("remote spawn stack");
  state.receive({ type: "frozen" }); await state.frozen.promise;
});

test("supervisor의 프로그래밍 결함은 예상 입력 오류로 바꾸지 않는다", async () => {
  const state = new ShellHandshake(() => {});
  state.receive({ type: "failed", expected: false, message: "unexpected defect", stack: "original remote stack" });
  const error = await state.started.promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PtyError);
  expect((error as Error).stack).toBe("original remote stack");
});
