import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
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
  await render(); pressLeader(app, "a"); await render();
  const prompt = get("session-prompt") as PromptInput;
  return {...app, view, selection, sent, copies, prompt, render, get, async click(id: string) { const n=get(id); await app.mockMouse.click(n.x+1,n.y); await render(); }, async close() {view.dispose(); await app.dispose();}};
}

test("Help shows contextual/shared keys and restores input draft, caret, and focus on close", async () => {
  const app = await mount();
  try {
    app.mockInput.pressArrow("left"); const cursor = app.prompt.cursorOffset;
    app.mockInput.pressKey("F1"); await app.render();
    expect(app.get("text-dialog").visible).toBe(true); expect(app.captureCharFrame()).toContain("Current context: prompt");
    app.mockInput.pressKey("y"); await app.render();
    expect(app.copies[0]).toContain("Application shortcuts"); expect(app.copies[0]).toContain("<S-CR>"); expect(app.copies[0]).toContain("<leader>b");

    // Global focus commands elsewhere must not manipulate editors behind open modals.
    openWorkspaceSearch(app); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    app.mockInput.pressEscape(); await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.prompt.cursorOffset).toBe(cursor);
    expect(app.prompt.value).toBe("untouched draft"); expect(app.sent).toEqual([]);
  } finally {await app.close();}
});

test("Footer Help clicks remember original focus and retain compact entry points", async () => {
  const app = await mount();
  try {
    // Abbreviated Help shortcuts retain Neovim notation in compact layouts.
    app.resize(60,16); await app.render();
    expect(app.get("footer-help").visible).toBe(true);
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<F1>");
    await app.click("footer-help");
    expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render();

    expect(app.renderer.currentFocusedRenderable).toBe(app.prompt); expect(app.prompt.value).toBe("untouched draft");
  } finally {await app.close();}
});

test("Notifications leave footer height stable and Messages reads/copies untruncated source", async () => {
  const app = await mount();
  try {
    const footer = app.get("app-footer"); expect(footer.height).toBe(1);
    const message = "[CONNECTION_FAILED] Temporary connection failure\n" + "Detailed cause. ".repeat(200) + "\nRecovery: reconnect after saving your work.";
    app.view.setNotice(message, { level: "error" }); await app.render();
    expect(footer.height).toBe(1); expect(app.renderer.root.findDescendantById("footer-notice")?.visible).toBe(false);
    expect(app.captureCharFrame()).toContain("Temporary connection");
    expect(app.captureCharFrame()).not.toContain("Detailed cause.");
    expect(app.captureCharFrame()).toContain("AGENT / radian");
    pressLeader(app, "!"); app.mockInput.pressEnter(); app.mockInput.pressKey("y"); await app.render();

    expect(app.copies).toEqual([message]); expect(app.get("text-dialog").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.get("messages").visible).toBe(true);
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
    app.view.setNotice(""); await app.render(); expect(footer.height).toBe(1);
    expect(app.sent).toEqual([]);
  } finally {await app.close();}
});

test("Help reflects overrides and blocks asynchronous focus restoration outside modals", async () => {
  const keymap = expectOk(parseKeymap({leader: "ctrl+b", bindings: {"app.help": [{keys: "f2", scope: "app"}], "app.detach": ["<leader> q"]}}));
  const app = await mount({keymap, onDetach: () => {}});
  try {
    // Show actual remapped keys separately while command lists retain logical leaders.
    expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).toContain("<F2> Help");
    app.mockInput.pressKey("F2"); await app.render(); app.mockInput.pressKey("y"); await app.render();
    expect(app.copies[0]).toContain("<leader>: <C-b>");
    expect(app.copies[0]).toContain("<leader>q"); expect(app.copies[0]).not.toContain("<leader>d");
    app.prompt.focus(); await app.render();

    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    const visited = new Set<string>();
    for(let i=0;i<6;i++) { app.mockInput.pressTab(); await app.render(); visited.add(app.renderer.currentFocusedRenderable?.id ?? "none"); }
    expect([...visited]).toEqual(["text-dialog-scroll"]);
    for (const id of ["text-dialog-copy", "text-dialog-close", "text-dialog-remove"]) expect(app.renderer.root.findDescendantById(id)).toBeUndefined();
    app.mockInput.pressEscape(); await app.render(); expect(app.renderer.currentFocusedRenderable).toBe(app.prompt);
  } finally {await app.close();}
});
