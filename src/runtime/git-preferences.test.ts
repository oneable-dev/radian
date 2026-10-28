import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { initialGitState } from "../git/model.ts";
import {
  emptyPreferences,
  parseCommand,
  preferencesSchema,
  type RuntimePreferences,
} from "./protocol.ts";
import { restoreWorkViews, saveWorkViews } from "./work-view-preferences.ts";
import { expectError } from "../testing/results.ts";

test("Git state persists as additive preferences alongside Terminal state", () => {
  // Existing wire enums remain unchanged while Git identities and positions are persisted separately.
  const preferences: RuntimePreferences = structuredClone(emptyPreferences);
  const state = {
    ...initialGitState(),
    selected: "a".repeat(40),
    diff: true,
    file: "commit:src/file.ts",
    diffScroll: 42,
  };

  saveWorkViews(preferences, {
    active: { main: "git", other: "terminal" },
    agentScroll: {},
    gitViews: { main: state },
    terminalSelection: { other: "shell" },
  });

  const restored = restoreWorkViews(preferences);

  expect(Value.Check(preferencesSchema, preferences)).toBe(true);
  expect(restored.gitViews?.main).toEqual(state);
  expect(restored.active).toEqual({ main: "git", other: "terminal" });
  expect(restored.terminalSelection).toEqual({ other: "shell" });
  expect(JSON.stringify(preferences.gitViews)).not.toContain("file contents");
});

test("Invalid external Git tabs, limits, and scroll values fail protocol validation", () => {
  // Restoration must not accept unbounded output requests or negative scroll coordinates.
  for (const changed of [{ tab: "graph" }, { limit: 300000 }, { diffScroll: -1 }]) {
    const preferences = {
      ...structuredClone(emptyPreferences),
      gitViews: { main: { ...initialGitState(), ...changed } },
    };

    const result = parseCommand(JSON.stringify({ type: "preferences", preferences }));

    expect(expectError(result).code).toBe("INVALID_INPUT");
  }
});
