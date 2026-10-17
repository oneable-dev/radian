import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { initialGitState } from "../git/model.ts";
import { emptyTranscriptView } from "../agents/transcript-preferences.ts";
import type { Repository } from "../workspace/model.ts";
import { defaultPreferences } from "./client.ts";
import { preferencesSchema, type RuntimePreferences } from "./protocol.ts";
import { mergeWorkspacePreferences, repositoryPreferences } from "./workspace-preferences.ts";

const repository: Repository = { id: "repo-a", name: "A", worktrees: [{ id: "tree-a", path: "/a", name: "A", branch: "main", sessions: [{ id: "session-a", name: "A", status: null, subagents: [] }] }] };
function preferences(tree: string, session: string): RuntimePreferences {
  return { selection: { worktreeId: tree, sessions: { [tree]: session } }, drafts: { [session]: `draft-${session}` },
    workViews: { active: { [tree]: "editor" }, agentScroll: { [session]: 7 } }, gitViews: { [tree]: initialGitState() }, agentViews: { [session]: emptyTranscriptView() },
    terminalViews: { active: [tree], selected: { [tree]: `terminal-${tree}` } } };
}

test("여러 레포의 초안과 뷰 상태를 합쳐도 레포별 저장에는 다른 레포 상태가 섞이지 않는다", () => {
  // 각 데몬의 선택과 터미널/스크롤은 독립된 저장 범위를 가진다.
  const a = preferences("tree-a", "session-a"), b = preferences("tree-b", "session-b");

  const merged = mergeWorkspacePreferences([a, b], "tree-b");
  const scoped = repositoryPreferences(merged, repository, a);

  // 비활성 레포의 로컬 선택은 유지하고 병합된 다른 레포 데이터는 제외한다.
  expect(merged.selection.worktreeId).toBe("tree-b");
  expect(merged.drafts).toEqual({ "session-a": "draft-session-a", "session-b": "draft-session-b" });
  expect(scoped).toEqual(a);
  expect(Value.Check(preferencesSchema, scoped)).toBe(true);
  merged.drafts["session-a"] = "changed";
  expect(a.drafts["session-a"]).toBe("draft-session-a");
});

test("늦은 snapshot 전의 신규 세션과 닫힌 세션의 초안도 소유 레포에만 저장한다", () => {
  // 새 ID는 아직 행에 없고 이전 세션의 보관 초안은 manifest에만 남아 있다.
  const previous = preferences("tree-a", "session-a");
  previous.drafts["archived-a"] = "retained";
  const incoming = mergeWorkspacePreferences([previous, preferences("tree-b", "session-b")], "tree-a");
  incoming.drafts["new-a"] = "new draft";
  incoming.workViews!.agentScroll["new-a"] = 12;

  const scoped = repositoryPreferences(incoming, repository, previous, ["new-a"]);

  // 열린 행만으로 소유권을 판단해 초안을 잃거나 타 레포로 복제하지 않는다.
  expect(scoped.drafts).toEqual({ "session-a": "draft-session-a", "archived-a": "retained", "new-a": "new draft" });
  expect(scoped.workViews?.agentScroll).toEqual({ "session-a": 7, "new-a": 12 });
  expect(scoped.selection.sessions).toEqual({ "tree-a": "session-a" });
});

test("비어 있거나 구버전인 UI 설정도 기존 wire 계약에 맞게 병합한다", () => {
  // 선택/초안만 저장한 구버전 설정을 그대로 수용한다.
  const merged = mergeWorkspacePreferences([defaultPreferences()], null);

  const scoped = repositoryPreferences(merged, repository, defaultPreferences());

  // 새 통합 레이어 때문에 데몬 프로토콜이나 manifest 버전을 바꾸지 않는다.
  expect(Value.Check(preferencesSchema, scoped)).toBe(true);
  expect(scoped.drafts).toEqual({});
  expect(scoped.workViews).toEqual({ active: {}, agentScroll: {} });
});
