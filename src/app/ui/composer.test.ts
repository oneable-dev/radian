import { pressLeader } from "../../testing/keys.ts";
import { expect, spyOn, test } from "bun:test";
import { ScrollBoxRenderable, type ClipboardRepresentation } from "@opentui/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { InputError, type ExpectedError } from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { tinyPng } from "../../testing/image.ts";
import type { PromptDraft } from "../../agents/prompt-input.ts";
import type { CompletionResult } from "../../agents/completion.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace()), sent: { id: string; text: string; images: readonly string[] }[] = [];
  const saved: Record<string, PromptDraft>[] = [], copies: string[] = [];
  const view = new Workbench(app.renderer, selection, { onNewSession: () => {}, onCloseSession: () => {},
    getSessionDetails: () => ({status: "working", output: "", error: null, sections: [{id: "original", kind: "user", title: "You", text: "Original task", status: "complete"}]}),
    onPrompt: (id, text, images) => { sent.push({id, text, images: images ?? []}); return ok(undefined); },
    onDraftChange: (_legacy, drafts) => saved.push(structuredClone(drafts)), onCopyTranscript: async (text) => { copies.push(text); return ok("Copied fixture"); }, ...actions });
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const render = async () => { for (let i=0;i<8;i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  await render(); pressLeader(app, "a"); await render();
  const input = get("session-prompt"); if (!(input instanceof PromptInput)) throw new Error("Missing prompt editor.");
  return { ...app, clock, view, input, selection, sent, saved, copies, get, render,
    async click(id: string) { const node = get(id); await app.mockMouse.click(node.x + 1, node.y); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test.each([
  { width: 120, height: 30, paused: false, status: "complete" },
  { width: 60, height: 18, paused: false, status: "complete" },
  { width: 120, height: 30, paused: true, status: "complete" },
  { width: 60, height: 18, paused: true, status: "complete" },
  { width: 120, height: 30, paused: false, status: "working" },
  { width: 60, height: 18, paused: false, status: "working" },
] as const)("Repeated paste loading preserves transcript height, scroll, and input width: %j", async ({ width, height, paused, status }) => {
  // Use an owned image-file URL so the real attachment path runs without changing the OS clipboard or user cache.
  const directory = await mkdtemp(join(tmpdir(), "radian-paste-layout-")), image = join(directory, "image.png");
  await writeFile(image, tinyPng());
  const representation: ClipboardRepresentation = { mimeType: "text/uri-list", bytes: new TextEncoder().encode(pathToFileURL(image).href) };
  let pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  const read = spyOn(Clipboard.prototype, "read").mockImplementation(() => pending.promise);
  const app = await mount({ getSessionDetails: () => ({ status, output: "", error: null, sections: [
    { id: "answer", kind: "assistant", title: "Agent", text: "```text\n" + Array.from({ length: 80 }, (_, i) => `LINE-${String(i).padStart(3, "0")}`).join("\n") + "\n```", status: "complete" },
  ] }) });
  try {
    app.selection.replaceSnapshot(app.selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => ({ ...tree,
      sessions: tree.sessions.map((session) => ({ ...session, subagents: [] })),
    })) })));
    app.resize(width, height); app.input.value = "draft "; await app.render();
    const scroll = app.get("session-transcript"), composer = app.get("agent-composer"), spinner = app.get("prompt-paste-loading");
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing native transcript viewport");
    if (paused) {
      pressLeader(app, "["); app.mockInput.pressKey("HOME"); await app.render();
      scroll.scrollTo(10); await app.render(); pressLeader(app, "a"); await app.render();
      expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(false);
    }
    const geometry = () => [scroll.y, scroll.height, scroll.scrollTop, composer.y, composer.height, app.input.width,
      app.captureCharFrame().match(/LINE-\d+/u)?.[0]];
    const before = geometry();
    for (let index = 1; index <= 2; index++) {
      pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
      app.mockInput.pressKey("v", { ctrl: true }); await app.render();

      // Reading and the spinner tail must use existing composer cells, never a temporary status row.
      expect(app.input.pending).toBe(true); expect(spinner.visible).toBe(true); expect(geometry()).toEqual(before);
      expect(spinner.parent?.id).toBe(composer.id);
      expect(spinner.x).toBeGreaterThanOrEqual(app.input.x + app.input.width);
      expect(spinner.x + spinner.width).toBeLessThanOrEqual(composer.x + composer.width);
      expect(spinner.y).toBeGreaterThanOrEqual(composer.y); expect(spinner.y + spinner.height).toBeLessThanOrEqual(composer.y + composer.height);
      pending.resolve(ok(representation)); await app.render();
      expect(app.input.submission.images).toHaveLength(index); expect(app.input.pending).toBe(false);
      expect(spinner.visible).toBe(true); expect(geometry()).toEqual(before);
      app.clock.advance(499); await app.render(); expect(spinner.visible).toBe(true); expect(geometry()).toEqual(before);
      app.clock.advance(1); await app.render(); expect(spinner.visible).toBe(false); expect(geometry()).toEqual(before);
      expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id); expect(app.sent).toEqual([]);
    }
  } finally { pending.resolve(ok(representation)); await app.render(); read.mockRestore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Hiding composer screens cancels paste loading immediately and rejects late images", async () => {
  const pending = Promise.withResolvers<Result<ClipboardRepresentation, ExpectedError>>();
  let signal: AbortSignal | undefined;
  const read = spyOn(Clipboard.prototype, "read").mockImplementation((abort) => { signal = abort; return pending.promise; });
  const app = await mount();
  try {
    app.input.value = "retained draft"; app.mockInput.pressKey("v", { ctrl: true }); await app.render();
    expect(app.input.activity.root.visible).toBe(true);
    app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("e"); await app.render();

    // A hidden composer must not leave either its spinner timers or a clipboard operation alive.
    expect(signal?.aborted).toBe(true); expect(app.input.pending).toBe(false); expect(app.input.activity.root.visible).toBe(false);
    pending.resolve(ok({ mimeType: "image/png", bytes: tinyPng() })); await app.render();
    app.clock.advance(1000); await app.render();
    expect(app.input.draft.tokens).toEqual([]); expect(app.input.value).toBe("retained draft"); expect(app.sent).toEqual([]);
    expect(app.input.activity.root.visible).toBe(false);
  } finally { pending.resolve(ok({ mimeType: "image/png", bytes: tinyPng() })); await app.render(); read.mockRestore(); await app.close(); }
});

test.each(["", "first\nsecond"])("Clicking input padding and borders focuses input while preserving drafts and caret: %j", async (draft) => {
  // Empty and multiline drafts share the whole composer surface as their click target.
  const app = await mount();
  try {
    app.input.value = draft; app.input.cursorOffset = Math.min(2, draft.length);
    for (const width of [120, 60]) {
      app.resize(width, 30); await app.render();
      const composer = app.get("agent-composer"), cursor = app.input.cursorOffset;
      const points = [
        [composer.x, app.input.y], [app.input.x - 1, app.input.y],
        [app.input.x + app.input.width, app.input.y],
        [app.input.x + 2, composer.y], [app.input.x + 2, composer.y + composer.height - 1],
      ] as const;
      // Move focus away before every click so an already-focused editor cannot mask a missed hit.
      for (const [x, y] of points) {
        app.get("workspace-tree").focus(); await app.render();
        await app.mockMouse.click(x, y); await app.render();

        expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
        expect(app.input.value).toBe(draft); expect(app.input.cursorOffset).toBe(cursor);
        expect(app.sent).toEqual([]);
      }
    }
    // Subsequent typing belongs to the editor, not the previously focused sidebar.
    const cursor = app.input.cursorOffset;
    await app.mockInput.typeText("!"); await app.render();
    expect(app.input.value).toBe(draft.slice(0, cursor) + "!" + draft.slice(cursor));
  } finally { await app.close(); }
});

test("Input text clicks retain native caret positions and padding right-clicks preserve focus", async () => {
  // The larger hit target must not replace native text hit-testing or react to secondary clicks.
  const app = await mount();
  try {
    app.input.value = "abcdef"; await app.render();
    app.get("workspace-tree").focus(); await app.render();
    const composer = app.get("agent-composer");
    await app.mockMouse.click(app.input.x + 2, composer.y, 2); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.get("workspace-tree"));

    await app.mockMouse.click(app.input.x + 2, app.input.y); await app.render();
    await app.mockInput.typeText("!"); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("ab!cdef"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Shift Enter creates multiline drafts and Enter submits once with newlines intact", async () => {
  const app = await mount();
  try {
    // Content alone determines expansion; submission and newline insertion remain distinct.
    await app.mockInput.typeText("first"); app.mockInput.pressEnter({shift:true}); await app.mockInput.typeText("second"); await app.render();
    expect(app.input.value).toBe("first\nsecond"); expect(app.sent).toEqual([]); expect(app.input.height).toBe(2);
    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual([{id: "a1", text: "first\nsecond", images: []}]); expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptInputDrafts.a1).toBeUndefined();
  } finally { await app.close(); }
});

test("Rejected command submission cancels completion loading while preserving draft, caret, and focus", async () => {
  // Completion is optional discovery; rejection still belongs to the ordinary submission contract.
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const sent: string[] = []; let signal: AbortSignal | undefined;
  const app = await mount({
    onComplete: async (_id, _query, abort) => { signal = abort; return pending.promise; },
    onPrompt: (_id, text) => { sent.push(text); return err(new InputError("Rejected command")); },
  });
  try {
    app.input.value = "/new"; await app.render(); app.clock.advance(150); await app.render();
    const cursor = app.input.cursorOffset;
    expect(app.get("prompt-completions").visible).toBe(true);
    app.mockInput.pressEnter(); await app.render();
    pending.resolve(ok({ items: [], truncated: false })); await app.render();

    expect(sent).toEqual(["/new"]); expect(signal?.aborted).toBe(true);
    expect(app.input.value).toBe("/new"); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.view.promptDrafts.a1).toBe("/new"); expect(app.get("prompt-completions").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
    expect(app.captureCharFrame()).toContain("Rejected command");
  } finally { pending.resolve(ok({ items: [], truncated: false })); await app.close(); }
});

test("Long pastes, images, and files collapse only visually and deliver full data/references after acceptance", async () => {
  const app = await mount();
  try {
    const text = "long original content\n".repeat(500);
    await app.mockInput.pasteBracketedText(text); await app.mockInput.typeText(" ");
    await app.mockInput.pasteBracketedText("/tmp/image.png /tmp/file.txt"); await app.render();
    expect(app.input.value).toContain("[Pasted Content"); expect(app.input.value).toContain("[Image #1]"); expect(app.input.value).toContain("[File #1]");
    expect(app.input.value).not.toContain("/tmp/");
    app.mockInput.pressEnter(); await app.render();

    expect(app.sent[0]).toEqual({id: "a1", text: `${text} [Image #1] @"/tmp/file.txt" `, images: ["/tmp/image.png"]});
    expect(app.input.value).toBe(""); expect(app.renderer.root.findDescendantById("agent-request")).toBeUndefined();
  } finally { await app.close(); }
});

test("Rejected attachments survive session round-trips and new Workbench restoration with source and caret intact", async () => {
  const app = await mount({ onPrompt: () => err(new InputError("Rejected fixture")) });
  let drafts: Record<string, PromptDraft> = {};
  try {
    const text = "keep all of this\n".repeat(100);
    await app.mockInput.pasteBracketedText(text); await app.mockInput.pasteBracketedText("/tmp/image.png"); await app.render();
    app.mockInput.pressEnter(); await app.render();
    expect(app.input.value).toContain("[Image #1]");
    app.mockInput.pressArrow("left"); const cursor = app.input.cursorOffset, expanded = app.input.submission;
    app.selection.selectSession("demo:main", "a2"); await app.render();
    await app.mockInput.typeText("other draft");
    app.selection.selectSession("demo:main", "a1"); await app.render();

    expect(app.input.cursorOffset).toBe(cursor); expect(app.input.submission).toEqual(expanded);
    drafts = app.view.promptInputDrafts;
  } finally { await app.close(); }
  const next = await mount({ initialInputDrafts: drafts });
  try {
    expect(next.input.value).toContain("[Image #1]"); expect(next.input.submission.images).toEqual(["/tmp/image.png"]);
    expect(next.input.submission.text).toContain("keep all of this\n"); expect(next.sent).toEqual([]);
  } finally { await next.close(); }
});

test("Item details show source and restore draft, caret, and focus on close", async () => {
  const app = await mount();
  try {
    const text = "original large paste\n".repeat(100);
    await app.mockInput.pasteBracketedText(text); await app.render(); const cursor = app.input.cursorOffset;
    app.mockInput.pressKey("o", {ctrl:true}); await app.render();
    expect(app.get("text-dialog").visible).toBe(true); expect(app.captureCharFrame()).toContain("original large paste");
    app.mockInput.pressKey("y"); await app.render();
    expect(app.copies).toEqual([text]);
    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input); expect(app.input.cursorOffset).toBe(cursor);
    expect(app.input.submission.text).toBe(text); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});

test("Compact multiline input, activity, notifications, and completion never overlap footers", async () => {
  const app=await mount({onComplete:async()=>ok({items:[{kind:"file",value:"context.txt",description:"Context file"}],truncated:false})});
  try {
    // Removing the view strip gives back two rows; use the same constrained content budget.
    app.resize(60,9);app.view.setNotice("Connection fixture notice");app.input.value="prefix\n@";await app.render();
    app.clock.advance(150);await app.render();expect(app.captureCharFrame()).toContain("context.txt");
    const menu=app.get("prompt-completions"),composer=app.get("agent-composer"),footer=app.get("app-footer"),status=app.get("session-status");
    expect(menu.visible).toBe(true);expect(menu.height).toBe(1);
    expect(composer.y+composer.height).toBeLessThanOrEqual(menu.y);expect(menu.y+menu.height).toBe(status.y);
    expect(status.height).toBe(3);expect(status.y+status.height).toBeLessThanOrEqual(footer.y);
    const row=status.getChildren()[0]!,frame=app.captureCharFrame().split("\n");
    // A zero-row conversation viewport must not leak its source text onto the mode line.
    const run=app.get("agent-run-status-text");
    expect(frame[run.y]!.slice(run.x,run.x+run.width)).toStartWith("Working (0s");
    expect(app.get("session-transcript").visible).toBe(false);
    expect(row.y-status.y).toBe(1);expect(status.y+status.height-row.y-row.height).toBe(1);
    for(const y of [row.y-1,row.y+1])expect(frame[y]!.slice(status.x,status.x+status.width).trim()).toBe("");
    expect(app.input.value).toBe("prefix\n@");expect(app.sent).toEqual([]);
    pressLeader(app, "[");await app.render();
    expect(menu.visible).toBe(false);expect(app.get("session-transcript").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable).not.toBe(app.input);expect(app.input.value).toBe("prefix\n@");
  }finally{await app.close();}
});

test("Long inputs limit display height only and compact input/completion never overlap footers", async () => {
  const app = await mount();
  try {
    // Directly edited text stays expanded and scrolls inside the editor.
    app.input.value = Array.from({length: 20}, (_, i) => `line ${i}`).join("\n"); await app.render();
    expect(app.input.height).toBe(6);
    app.resize(60,12); await app.render();

    expect(app.input.height).toBeLessThanOrEqual(2);
    const composer = app.get("agent-composer"), footer = app.get("app-footer"), status = app.get("session-status");
    expect(composer.y + composer.height).toBe(status.y); expect(status.y + status.height).toBeLessThanOrEqual(footer.y);
    expect(app.input.submission.text).toContain("line 19"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
