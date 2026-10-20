import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { InputError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import type { PromptDraft } from "../../agents/prompt-input.ts";

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
  await render(); app.mockInput.pressKey("e", {ctrl:true}); await render();
  const input = get("session-prompt"); if (!(input instanceof PromptInput)) throw new Error("Missing prompt editor.");
  return { ...app, clock, view, input, selection, sent, saved, copies, get, render,
    async click(id: string) { const node = get(id); await app.mockMouse.click(node.x + 1, node.y); await render(); },
    async close() { view.dispose(); await app.dispose(); } };
}

test("Shift Enter는 여러 줄 초안을 만들고 Enter는 줄바꿈을 보존해 한 번 전송한다", async () => {
  const app = await mount();
  try {
    // 입력 확장은 내용에 의해서만 결정되고 전송과 줄바꿈은 다른 동작이다.
    await app.mockInput.typeText("first"); app.mockInput.pressEnter({shift:true}); await app.mockInput.typeText("second"); await app.render();
    expect(app.input.value).toBe("first\nsecond"); expect(app.sent).toEqual([]); expect(app.input.height).toBe(2);
    app.mockInput.pressEnter(); await app.render();

    expect(app.sent).toEqual([{id: "a1", text: "first\nsecond", images: []}]); expect(app.input.value).toBe("");
    expect(app.view.promptDrafts.a1).toBeUndefined(); expect(app.view.promptInputDrafts.a1).toBeUndefined();
  } finally { await app.close(); }
});

test("긴 붙여넣기·이미지·파일은 표시만 접고 수락 뒤 실제 데이터와 참조를 전달한다", async () => {
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

test("거절된 첨부는 남고 세션 왕복과 새 Workbench에서도 원문과 커서를 복원한다", async () => {
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

test("항목 상세는 원문을 보여주고 닫을 때 초안·커서·포커스를 복원한다", async () => {
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

test("작은 창의 여러 줄 입력·실행 상태·알림·완성 후보가 함께 있어도 footer를 침범하지 않는다", async () => {
  const app=await mount({onComplete:async()=>ok({items:[{kind:"file",value:"context.txt",description:"Context file"}],truncated:false})});
  try {
    app.resize(60,11);app.view.setNotice("Connection fixture notice");app.input.value="prefix\n@";await app.render();
    app.clock.advance(150);await app.render();expect(app.captureCharFrame()).toContain("context.txt");
    const menu=app.get("prompt-completions"),composer=app.get("agent-composer"),footer=app.get("app-footer"),status=app.get("session-status");
    expect(menu.visible).toBe(true);expect(menu.height).toBe(1);
    expect(composer.y+composer.height).toBeLessThanOrEqual(menu.y);expect(menu.y+menu.height).toBe(status.y);
    expect(status.height).toBe(3);expect(status.y+status.height).toBeLessThanOrEqual(footer.y);
    const row=status.getChildren()[0]!,frame=app.captureCharFrame().split("\n");
    // A zero-row conversation viewport must not leak its source text onto the mode line.
    const run=app.get("agent-run-status-text");
    expect(frame[run.y]!.slice(run.x,run.x+run.width)).toStartWith("Working on “");
    expect(app.get("session-transcript").visible).toBe(false);
    expect(row.y-status.y).toBe(1);expect(status.y+status.height-row.y-row.height).toBe(1);
    for(const y of [row.y-1,row.y+1])expect(frame[y]!.slice(status.x,status.x+status.width).trim()).toBe("");
    expect(app.input.value).toBe("prefix\n@");expect(app.sent).toEqual([]);
    app.mockInput.pressKey("t",{ctrl:true});await app.render();
    expect(menu.visible).toBe(false);expect(app.get("session-transcript").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable).not.toBe(app.input);expect(app.input.value).toBe("prefix\n@");
  }finally{await app.close();}
});

test("긴 입력은 표시 높이만 제한하고 작은 창에서도 입력·완성 목록이 footer를 침범하지 않는다", async () => {
  const app = await mount();
  try {
    // 직접 편집 중인 텍스트는 접지 않으며 편집기 안에서 스크롤한다.
    app.input.value = Array.from({length: 20}, (_, i) => `line ${i}`).join("\n"); await app.render();
    expect(app.input.height).toBe(6);
    app.resize(60,12); await app.render();

    expect(app.input.height).toBeLessThanOrEqual(2);
    const composer = app.get("agent-composer"), footer = app.get("app-footer"), status = app.get("session-status");
    expect(composer.y + composer.height).toBe(status.y); expect(status.y + status.height).toBeLessThanOrEqual(footer.y);
    expect(app.input.submission.text).toContain("line 19"); expect(app.sent).toEqual([]);
  } finally { await app.close(); }
});
