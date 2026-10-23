import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { emptyTranscriptView } from "./transcript-preferences.ts";
import { emptyPreferences, parseCommand, parseSnapshot, preferencesSchema } from "../runtime/protocol.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("Agent navigation preferences serialize and restore without changing existing workViews format", () => {
  const preferences = structuredClone(emptyPreferences);
  const state = { ...emptyTranscriptView(), selectedId: "message:0", mode: "visual" as const, anchor: 0, linewise: true,
    folded: { thinking: false, "message:0": true }, cursors: { "message:0": 4 }, headingCursors: { "message:0": 2 }, renderedCursors: { "message:0": true }, follow: false };

  // Persist through the same boundary used by TUI detach/reconnect, not a UI object reference.
  saveWorkViews(preferences, { active: { tree: "agent" }, agentScroll: { session: 42 }, agentViews: { session: state } });
  const stored = JSON.parse(JSON.stringify(preferences));
  const command = expectOk(parseCommand(JSON.stringify({ type: "preferences", preferences: stored })));
  expect(command.type).toBe("preferences");
  const restored = restoreWorkViews(stored);

  expect(Value.Check(preferencesSchema, stored)).toBe(true);
  expect(preferences.workViews).toEqual({ active: { tree: "agent" }, agentScroll: { session: 42 } });
  expect(restored.agentViews?.session).toEqual(state);
  expect(restored.agentViews?.session?.linewise).toBe(true);
  expect(restored.agentViews?.session?.renderedCursors?.["message:0"]).toBe(true);
  restored.agentViews!.session!.cursors["message:0"] = 99;
  restored.agentViews!.session!.headingCursors!["message:0"] = 88;
  expect(preferences.agentViews?.session?.cursors["message:0"]).toBe(4);
  expect(preferences.agentViews?.session?.headingCursors?.["message:0"]).toBe(2);
});

test("Structured transcripts are optional wire fields and reject invalid states or negative cursors", () => {
  const legacy = { version: 1, pid: 123, instance: "instance", mode: "offline", repositoryId: "repo", repositories: [],
    details: { session: { status: null, output: "legacy", error: null } }, closingCount: 0, preferences: emptyPreferences, notice: "" };

  expectOk(parseSnapshot(legacy));
  const section = { id: "message", kind: "thinking", title: "Thinking", text: "full content", status: "streaming" };
  const modern = { ...legacy, details: { session: { ...legacy.details.session, sections: [section] } } };
  expect(expectOk(parseSnapshot(modern)).details.session?.sections?.[0]?.text).toBe("full content");
  const skill = { ...section, kind: "notice", title: "example-skill", text: "example-skill", skillName: "example-skill" };
  const skillSnapshot = { ...modern, details: { session: { ...modern.details.session, sections: [skill] } } };
  expect(expectOk(parseSnapshot(skillSnapshot)).details.session?.sections?.[0]?.skillName).toBe("example-skill");

  // Runtime inputs must be validated even though TypeScript callers use a typed view state.
  expect(expectError(parseSnapshot({ ...modern, details: { session: { ...modern.details.session, sections: [{ ...section, status: "invented" }] } } })).code).toBe("PROTOCOL_ERROR");
  const invalid = { ...emptyPreferences, agentViews: { session: { ...emptyTranscriptView(), cursors: { message: -1 } } } };
  expect(expectError(parseCommand(JSON.stringify({ type: "preferences", preferences: invalid }))).code).toBe("INVALID_INPUT");
});
