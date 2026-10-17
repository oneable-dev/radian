import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { icons } from "../../icons.ts";
import { ok } from "../../result.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench } from "./workbench.ts";

test("연결 전 다른 레포의 초안을 지우지 않고 연결 뒤 저장된 세션과 입력을 복원한다", async () => {
  const setup = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const repositories: Repository[] = ["A", "B"].map((name) => ({ id: name, name: `${name}-repo`, worktrees: [{ id: `tree-${name}`, path: `/${name}`, name: `${name}-folder`, branch: "main",
    sessions: name === "A" ? [{ id: "a1", name: "A session", status: null, subagents: [] }] : [] }] }));
  const selection = new WorkspaceSelection(repositories);
  let cold = true;
  // B는 아직 연결하지 않았지만 이전 TUI가 저장한 세션 초안이 있다.
  const view = new Workbench(setup.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {}, onPrompt: async () => ok(undefined),
    initialDrafts: { a1: "draft A", b2: "retained draft B" }, getRetainedSessionIds: () => new Set(cold ? ["b2"] : []) });
  try {
    await setup.renderOnce();
    expect(view.promptDrafts.b2).toBe("retained draft B");

    // B의 실제 세션 snapshot이 늦게 도착하고 사용자가 그 폴더를 연다.
    cold = false;
    selection.replaceSnapshot(repositories.map((repo) => repo.id !== "B" ? repo : { ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: ["b1", "b2"].map((id) => ({ id, name: id, status: null, subagents: [] })) })) }), { "tree-B": "b2" });
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes(`${icons.folder} B-folder`));
    await setup.mockMouse.click(lines[y]!.indexOf("B-folder"), y); await setup.renderOnce();

    // 첫 세션 b1이 아니라 저장된 b2와 그 입력을 보여 주며 A의 초안도 남는다.
    const prompt = setup.renderer.root.findDescendantById("session-prompt");
    if (!(prompt instanceof InputRenderable)) throw new Error("Missing session prompt.");
    expect(selection.sessionId).toBe("b2");
    expect(prompt.value).toBe("retained draft B");
    expect(view.promptDrafts.a1).toBe("draft A");
    expect(setup.captureCharFrame()).toContain("A-repo");
    expect(setup.captureCharFrame()).toContain("B-repo");
  } finally { view.dispose(); await setup.dispose(); }
});
