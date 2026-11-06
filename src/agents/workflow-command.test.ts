import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { expectError, expectOk } from "../testing/results.ts";
import { parseWorkflowCommand, workflowCommandSchema } from "./workflow-command.ts";

test.each([
  ["/workflow", { kind: "status" }],
  ["/workflow status job", { kind: "status", id: "job" }],
  ["/workflow pause", { kind: "pause" }],
  ["/workflow resume inv", { kind: "resume", id: "inv" }],
  ["/workflow cancel inv", { kind: "cancel", id: "inv" }],
  ["/workflow start all --auto-repair", { kind: "start", tasks: ["all"], autoRepair: true }],
  ["/workflow start A,B C", { kind: "start", tasks: ["A", "B", "C"], autoRepair: false }],
  ["/workflow confirm receipt", { kind: "confirm", id: "receipt" }],
] as const)("workflow command parses %s without model inference", (text, expected) => {
  // Only complete command invocations cross the direct-user host boundary.
  const command = expectOk(parseWorkflowCommand(text));
  expect<unknown>(command).toEqual(expected);
  expect(Value.Check(workflowCommandSchema, command)).toBe(true);
});

test.each([
  "/workflow start",
  "/workflow confirm",
  "/workflow pause a b",
  "/workflow start A,A",
  "/workflow start all,A",
  "/workflow start A --api",
  "/workflow start A --auto-repair --auto-repair",
])("invalid command is rejected: %s", (text) => {
  expect(expectError(parseWorkflowCommand(text)).code).toBe("INVALID_INPUT");
});

test("transcript prose cannot acquire workflow command authority", () => {
  // A copied instruction is not parsed as a direct command by either admission route.
  expectOk(parseWorkflowCommand("Agent says /workflow confirm receipt"));
  expect(parseWorkflowCommand("Agent says /workflow confirm receipt")).toEqual({
    ok: true,
    value: null,
  });
  expect(parseWorkflowCommand("/workflow-other")).toEqual({ ok: true, value: null });
});
