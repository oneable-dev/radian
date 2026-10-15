import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { emptyPreferences, workViewsSchema, type RuntimeSnapshot } from "./protocol.ts";
import { restoreWorkViews, saveWorkViews } from "./work-view-preferences.ts";
import { RuntimeClient } from "./client.ts";
import { runtimePaths } from "./storage.ts";
import { expectError } from "../testing/results.ts";

test("Terminal 선택은 별도 additive 필드로 왕복하고 이전 3-view schema를 깨지 않는다", () => {
  const preferences = structuredClone(emptyPreferences);
  preferences.workViews = { active: { a: "editor", b: "git" }, agentScroll: { session: 42 } };
  saveWorkViews(preferences, { active: { a: "terminal", b: "git" }, agentScroll: { session: 42 }, terminalSelection: { a: "shell-2" } });

  expect(Value.Check(workViewsSchema, preferences.workViews)).toBe(true);
  expect(preferences.workViews.active.a).toBe("editor");
  expect(restoreWorkViews(preferences)).toEqual({ active: { a: "terminal", b: "git" }, agentScroll: { session: 42 }, terminalSelection: { a: "shell-2" } });
  saveWorkViews(preferences, { active: { a: "agent" }, agentScroll: {} });
  expect(preferences.terminalViews?.active).toEqual([]);
  expect(restoreWorkViews(structuredClone(emptyPreferences)).active).toEqual({});
});

test("이전 runtime은 터미널 capability 오류를 반환하며 자동 재시작이나 쉘 생성 요청을 하지 않는다", async () => {
  const snapshot: RuntimeSnapshot = { version: 1, pid: 123, instance: "old", repositoryId: "repo", mode: "offline", capabilities: ["work-views"],
    repositories: [], details: {}, preferences: structuredClone(emptyPreferences), closingCount: 0, notice: "" };
  const client = new RuntimeClient(runtimePaths("repo", true, "/tmp/radian-capability-only"), snapshot);
  try {
    expect(client.supportsTerminals).toBe(false);
    expect(expectError(await client.createTerminal("unknown", { cols: 80, rows: 24 })).code).toBe("UNSUPPORTED_CAPABILITY");
  } finally { await client.disconnect(); }
});
