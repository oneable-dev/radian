import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { initialGitState } from "../git/model.ts";
import { emptyTranscriptView } from "../agents/transcript-preferences.ts";
import type { Repository } from "../workspace/model.ts";
import { defaultPreferences } from "./client.ts";
import { preferencesSchema, type RuntimePreferences } from "./protocol.ts";
import { mergeWorkspacePreferences, repositoryPreferences } from "./workspace-preferences.ts";

const repository: Repository = {
  id: "repo-a",
  name: "A",
  worktrees: [
    {
      id: "tree-a",
      path: "/a",
      name: "A",
      branch: "main",
      sessions: [{ id: "session-a", name: "A", status: null, subagents: [] }],
    },
  ],
};
function preferences(tree: string, session: string): RuntimePreferences {
  return {
    selection: { worktreeId: tree, sessions: { [tree]: session } },
    drafts: { [session]: `draft-${session}` },
    workViews: { active: { [tree]: "editor" }, agentScroll: { [session]: 7 } },
    gitViews: { [tree]: initialGitState() },
    agentViews: { [session]: emptyTranscriptView() },
    terminalViews: { active: [tree], selected: { [tree]: `terminal-${tree}` } },
  };
}

test("Merged repository drafts/views never contaminate per-repository persistence", () => {
  // Each daemon scopes selection, terminal state, and scroll independently.
  const a = preferences("tree-a", "session-a"),
    b = preferences("tree-b", "session-b");

  const merged = mergeWorkspacePreferences([a, b], "tree-b");
  const scoped = repositoryPreferences(merged, repository, a);

  // Retain inactive local selections and exclude merged foreign data.
  expect(merged.selection.worktreeId).toBe("tree-b");
  expect(merged.drafts).toEqual({ "session-a": "draft-session-a", "session-b": "draft-session-b" });
  expect(scoped).toEqual(a);
  expect(Value.Check(preferencesSchema, scoped)).toBe(true);
  merged.drafts["session-a"] = "changed";
  expect(a.drafts["session-a"]).toBe("draft-session-a");
});

test("New IDs before snapshots and closed-session drafts persist only to owning repositories", () => {
  // New IDs lack rows and old retained drafts may exist only in manifests.
  const previous = preferences("tree-a", "session-a");
  previous.drafts["archived-a"] = "retained";
  const incoming = mergeWorkspacePreferences(
    [previous, preferences("tree-b", "session-b")],
    "tree-a",
  );
  incoming.drafts["new-a"] = "new draft";
  incoming.workViews!.agentScroll["new-a"] = 12;

  const scoped = repositoryPreferences(incoming, repository, previous, ["new-a"]);

  // Open rows alone cannot determine ownership without losing or duplicating drafts.
  expect(scoped.drafts).toEqual({
    "session-a": "draft-session-a",
    "archived-a": "retained",
    "new-a": "new draft",
  });
  expect(scoped.workViews?.agentScroll).toEqual({ "session-a": 7, "new-a": 12 });
  expect(scoped.selection.sessions).toEqual({ "tree-a": "session-a" });
});

test("Empty and legacy UI settings merge under existing wire contracts", () => {
  // Accept legacy selection/draft-only settings unchanged.
  const merged = mergeWorkspacePreferences([defaultPreferences()], null);

  const scoped = repositoryPreferences(merged, repository, defaultPreferences());

  // New aggregation must not change daemon protocol or manifest versions.
  expect(Value.Check(preferencesSchema, scoped)).toBe(true);
  expect(scoped.drafts).toEqual({});
  expect(scoped.workViews).toEqual({ active: {}, agentScroll: {} });
});
