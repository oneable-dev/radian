import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { modelCommand } from "../../agents/model-selection.ts";
import { ok } from "../../result.ts";

type Surface = "history" | "monitor" | "model";
const navigationCases = (["history", "monitor", "model"] as const).flatMap(surface => [
  { surface, focus: "search", navigation: "control" },
  { surface, focus: "list", navigation: "control" },
  { surface, focus: "search", navigation: "arrows" },
  { surface, focus: "list", navigation: "arrows" },
  { surface, focus: "list", navigation: "vim" },
] as const);

async function mount(surface: Surface) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true, clock });
  const names = ["one", "two", "three"];
  const repositories = demoWorkspace().map(repository => ({ ...repository, worktrees: repository.worktrees.map(tree => tree.id !== "demo:main" ? tree : {
    ...tree, sessions: tree.sessions.map((session, index) => ({ ...session, name: `Candidate ${names[index]}`, status: "working" as const })),
  }) }));
  const selection = new WorkspaceSelection(repositories), resumed: string[] = [], models: string[] = [], submitted: string[] = [];
  const view = new Workbench(app.renderer, selection, {
    onNewSession() {}, onCloseSession() {}, initialDrafts: { a1: "KEEP_DRAFT" },
    onPrompt: (_id, text) => { submitted.push(text); return ok(undefined); },
    getSessionDetails: id => ({ conversationId: `conversation-${id}`, status: "working", output: `Preview ${id}`, error: null }),
    onComplete: async () => ok({ items: [modelCommand], truncated: false }),
    onListHistory: async worktreeId => ok(names.map(name => ({ id: `saved-${name}`, title: `Candidate ${name}`, worktreeId,
      modified: "2026-10-20T00:00:00Z", messageCount: 1, openSessionId: null, unavailableReason: null }))),
    onResumeSession: async (_tree, id) => { resumed.push(id); return ok("a2"); },
    onListModels: async (_id, conversationId) => ok({ conversationId, current: { provider: "fixture", id: "one" }, effort: "off",
      models: names.map(id => ({ provider: "fixture", id, name: `Candidate ${id}`, contextWindow: 1000, images: false, reasoning: false,
        efforts: ["off"], effort: "off" })) }),
    onSelectModel: async (_id, _conversation, model) => { models.push(model.id); return ok(null); },
  });
  const render = async () => { await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) throw new Error(`Missing ${id}`);
    return node;
  };
  await render();
  if (surface === "model") {
    const prompt = get("session-prompt") as InputRenderable;
    prompt.focus(); prompt.value = "/model"; await render(); clock.advance(150); await render();
    app.mockInput.pressEnter(); await render();
  } else {
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey(surface === "history" ? "h" : "s");
  }
  await render();
  return { ...app, selection, view, resumed, models, submitted, get, render,
    async close() { view.dispose(); await app.dispose(); } };
}

test.each(navigationCases)("$surface modal $focus focus supports $navigation candidate navigation while preserving input and drafts", async ({ surface, focus, navigation }) => {
  // Give three search modals identical candidates to detect focus-specific missing bindings.
  const app = await mount(surface);
  try {
    const input = app.get(`${surface}-search`) as InputRenderable;
    await app.mockInput.typeText("hjkl"); await app.render();
    expect(input.value).toBe("hjkl");
    for (let index = 0; index < 4; index++) app.mockInput.pressBackspace();
    await app.mockInput.typeText("candidate");
    if (focus === "list") app.mockInput.pressTab();
    await app.render();

    // Move down twice and up once without changing actual models/sessions before confirmation.
    const move = (next: boolean) => {
      if (navigation === "control") app.mockInput.pressKey(next ? "n" : "p", { ctrl: true });
      else if (navigation === "arrows") app.mockInput.pressArrow(next ? "down" : "up");
      else app.mockInput.pressKey(next ? "j" : "k");
    };
    move(true); move(true); move(false); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe(`${surface}-${focus}`); expect(input.value).toBe("candidate");
    expect(app.selection.sessionId).toBe("a1"); expect(app.resumed).toEqual([]); expect(app.models).toEqual([]);
    expect(app.view.promptDrafts.a1).toBe(surface === "model" ? undefined : "KEEP_DRAFT");
    const footer = app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
    expect(footer).not.toMatch(/[↑↓←]/u);
    expect(footer).not.toMatch(/Previous|Next|<C-[np]>|½ page/u);
    app.mockInput.pressEnter(); await app.render();

    if (surface === "model") expect(app.models).toEqual(["two"]);
    else if (surface === "history") expect(app.resumed).toEqual(["saved-two"]);
    else expect(app.selection.sessionId).toBe("a2");
    expect(app.submitted).toEqual([]);
  } finally { await app.close(); }
});
