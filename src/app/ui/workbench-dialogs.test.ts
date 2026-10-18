import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { ok } from "../../result.ts";

async function mount(actions: Partial<WorkbenchActions> = {}) {
  const app = await createTestRenderer({width: 120, height: 28, kittyKeyboard: true});
  const selection = new WorkspaceSelection(demoWorkspace()), sent: string[] = [], copies: string[] = [];
  const view = new Workbench(app.renderer, selection, {onNewSession: () => {}, onCloseSession: () => {},
    onPrompt: (_id, text) => { sent.push(text); return ok(undefined); }, getSessionDetails: () => ({status: null, error: null, output: "Transcript"}),
    initialDrafts: {a1: "untouched draft"}, onCopyTranscript: async (text) => { copies.push(text); return ok("Copied fixture"); }, ...actions});
  const render = async () => { for(let i=0;i<8;i++) await Promise.resolve(); await app.renderOnce(); await app.renderOnce(); };
  const get = (id: string) => { const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  await render(); app.mockInput.pressKey("e", {ctrl: true}); await render();
  const prompt = get("session-prompt") as PromptInput;
  return {...app, view, selection, sent, copies, prompt, render, get, async click(id: string) { const n=get(id); await app.mockMouse.click(n.x+1,n.y); await render(); }, async close() {view.dispose(); await app.dispose();}};
}

test("도움말은 현재 문맥과 공통 키를 보여주고 닫으면 입력 초안·커서·포커스를 복원한다", async () => {
  const app = await mount();
  try {
    app.mockInput.pressArrow("left"); const cursor = app.prompt.cursorOffset;
    app.mockInput.pressKey("F1"); await app.render();
    expect(app.get("text-dialog").visible).toBe(true); expect(app.captureCharFrame()).toContain("Current context: prompt");
    app.mockInput.pressKey("y"); await app.render();
    expect(app.copies[0]).toContain("Application shortcuts"); expect(app.copies[0]).toContain("Shift+Enter"); expect(app.copies[0]).toContain("Ctrl+Space → b");

    // 다른 영역의 전역 포커스 명령도 열린 모달 뒤의 편집기를 조작하지 않는다.
    app.mockInput.pressKey("f", {ctrl: true}); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.prompt.cursorOffset).toBe(cursor);
    expect(app.prompt.value).toBe("untouched draft"); expect(app.sent).toEqual([]);
  } finally {await app.close();}
});

test("푸터의 도움말 클릭은 원래 포커스를 기억하고 작은 화면에서도 진입점을 남긴다", async () => {
  const app = await mount();
  try {
    app.resize(60,16); await app.render();
    expect(app.get("footer-help").visible).toBe(true);
    await app.click("footer-help");
    expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.prompt.value).toBe("untouched draft");
  } finally {await app.close();}
});

test("알림이 있을 때만 한 줄을 예약하며 상세는 잘리지 않은 원문을 읽고 복사한다", async () => {
  const app = await mount();
  try {
    const footer = app.get("app-footer"); expect(footer.height).toBe(1);
    const message = "[CONNECTION_FAILED] Temporary connection failure\n" + "Detailed cause. ".repeat(200) + "\nRecovery: reconnect after saving your work.";
    app.view.setNotice(message); await app.render();
    expect(footer.height).toBe(2); expect(app.get("footer-notice").visible).toBe(true);
    expect(app.captureCharFrame()).toContain("Temporary connection failure");
    expect(app.captureCharFrame()).not.toContain("Detailed cause.");
    await app.click("footer-notice-details"); app.mockInput.pressKey("y"); await app.render();

    expect(app.copies).toEqual([message]); expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    app.view.setNotice(""); await app.render(); expect(footer.height).toBe(1); expect(app.get("footer-notice").visible).toBe(false);
    expect(app.sent).toEqual([]);
  } finally {await app.close();}
});

test("도움말은 사용자 재할당을 반영하고 모달 밖의 비동기 포커스 복원을 차단한다", async () => {
  const keymap = expectOk(parseKeymap({bindings: {"app.help": [{keys: "f2", scope: "app"}], "app.detach": ["<leader> q"]}}));
  const app = await mount({keymap, onDetach: () => {}});
  try {
    app.mockInput.pressKey("F2"); await app.render(); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies[0]).toContain("Ctrl+Space → q"); expect(app.copies[0]).not.toContain("Ctrl+Space → c");
    app.prompt.focus(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    const visited = new Set<string>();
    for(let i=0;i<6;i++) { app.mockInput.pressTab(); await app.render(); visited.add(app.renderer.currentFocusedRenderable?.id ?? "none"); }
    expect([...visited].every((id)=>id.startsWith("text-dialog"))).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally {await app.close();}
});
