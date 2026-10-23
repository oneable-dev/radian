import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseKeypress } from "@opentui/core";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { pressLeader } from "../../testing/keys.ts";
import { ok } from "../../result.ts";
import type { TerminalInfo, WorkView } from "../../runtime/protocol.ts";

async function mount(viewMode: WorkView = "agent", custom = false) {
  const app = await createTestRenderer({ width: 140, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
  const selection = new WorkspaceSelection(demoWorkspace());
  const requests: string[] = [], inputs: string[] = [];
  const terminals: TerminalInfo[] = [1, 2, 3].map(index => ({ id: `shell-${index}`, worktreeId: "demo:main", title: `sh ${index}`, pid: 100 + index, shellPid: 200 + index, exited: false, exitCode: null }));
  const keymap = custom ? expectOk(parseKeymap({ leader: "ctrl+b", bindings: {
    "tab.next": [{ keys: "alt+j", scope: "global" }], "tab.previous": [{ keys: "alt+k", scope: "global" }],
  } })) : undefined;
  const view = new Workbench(app.renderer, selection, {
    ...(keymap ? { keymap } : {}),
    initialWorkViews: { active: { "demo:main": viewMode }, agentScroll: {}, terminalSelection: { "demo:main": "shell-1" } },
    initialDrafts: { a1: "first draft", a2: "second draft", a3: "third draft" },
    onNewSession: (treeId, activate) => {
      const id = "created-agent"; requests.push(`create:${treeId}`);
      selection.replaceSnapshot(selection.snapshot.map(repo => ({ ...repo, worktrees: repo.worktrees.map(tree => tree.id !== treeId ? tree : {
        ...tree, sessions: [...tree.sessions, { id, name: "Created", status: null, subagents: [] }],
      }) })));
      activate?.(id);
    },
    onCloseSession() {}, onDetach: () => requests.push("detach"), onPrompt: () => ok(undefined),
    getSessionDetails: id => ({ status: "complete", output: `Output ${id}`, error: null }),
    terminal: {
      list: () => terminals,
      create: async tree => {
        const index = terminals.length + 1, id = `shell-${index}`;
        requests.push(`create:${tree}`); terminals.push({ ...terminals[0]!, id, pid: 100 + index, shellPid: 200 + index });
        selection.replaceSnapshot(selection.snapshot); return ok(id);
      },
      close: async () => ok(undefined),
      attach: async (id, receive) => {
        const terminal = terminals.find(item => item.id === id)!;
        let revision = 0;
        const send = (cols: number, rows: number) => receive({ ...terminal, cols, rows, revision: revision++, ansi: `\x1bcOutput ${id}` });
        send(80, 24);
        return ok({ input: data => inputs.push(Buffer.from(data).toString("hex")), resize: send, disconnect: async () => {},
          read: async () => ok({ text: `Output ${id}`, cursor: { row: 0, column: 0 } }) });
      },
    },
  });
  const render = async () => { for (let index = 0; index < 4; index++) await app.renderOnce(); };
  await render();
  return { ...app, selection, view, requests, inputs, terminals, render,
    leader(key: string) { if (custom) { app.mockInput.pressKey("b", { ctrl: true }); app.mockInput.pressKey(key); } else pressLeader(app, key); },
    active: () => viewMode === "terminal" ? view.workViewPreferences.terminalSelection?.["demo:main"] : selection.sessionId,
    async close() { view.dispose(); await app.dispose(); },
  };
}

test.each(["agent", "terminal"] as const)("%s leader+n/p cycles same-screen tabs without creation or detach", async mode => {
  // Global tab navigation during input stays scoped to current-worktree tab kinds.
  const app = await mount(mode), ids = mode === "agent" ? ["a1", "a2", "a3"] : ["shell-1", "shell-2", "shell-3"];
  try {
    app.leader("p"); await app.render(); expect(app.active()).toBe(ids[2]);
    app.leader("n"); await app.render(); expect(app.active()).toBe(ids[0]);
    app.leader("n"); await app.render(); expect(app.active()).toBe(ids[1]);
    app.leader("p"); await app.render();

    expect(app.active()).toBe(ids[0]); expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.view.promptDrafts).toMatchObject({ a1: "first draft", a2: "second draft", a3: "third draft" });
    expect(app.requests).toEqual([]); expect(app.inputs).toEqual([]);
    expect(app.renderer.currentFocusedRenderable?.id).toBe(mode === "agent" ? "session-prompt" : "shell-terminal");
  } finally { await app.close(); }
});

test.each(["agent", "terminal"] as const)("%s output navigation still uses n/p for current-screen tab commands", async mode => {
  // Global tab commands follow active screens even when reading modes own input.
  const app = await mount(mode);
  try {
    app.leader("["); await app.render();
    expect(app.renderer.currentFocusedRenderable?.id).toBe(mode === "agent" ? "session-transcript" : "terminal-copy");
    app.leader("n"); await app.render();

    expect(app.active()).toBe(mode === "agent" ? "a2" : "shell-2");
    expect(app.renderer.currentFocusedRenderable?.id).toBe(mode === "agent" ? "session-prompt" : "shell-terminal");
    expect(app.inputs).toEqual([]); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test.each(["agent", "terminal"] as const)("%s leader+c creates while only leader+d detaches", async mode => {
  // Reusing the old detach key for creation must never run both commands.
  const app = await mount(mode);
  try {
    app.leader("c"); await app.render();
    expect(app.requests).toEqual(["create:demo:main"]); expect(app.active()).toBe(mode === "agent" ? "created-agent" : "shell-4");
    app.leader("d"); await app.render();

    expect(app.requests).toEqual(["create:demo:main", "detach"]); expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("leader+u opens usage and popup c/n/p never changes underlying tabs", async () => {
  // Usage and detach have separate bindings while popups own input.
  const app = await mount();
  try {
    app.leader("u"); await app.render();
    expect(app.renderer.root.findDescendantById("agent-dashboard")?.visible).toBe(true);
    const focus = app.renderer.currentFocusedRenderable;
    for (const key of ["c", "n", "p"]) app.leader(key);
    await app.render();

    expect(app.active()).toBe("a1"); expect(app.requests).toEqual([]); expect(app.renderer.currentFocusedRenderable).toBe(focus);
    app.leader("d"); expect(app.requests).toEqual(["detach"]);
  } finally { await app.close(); }
});

test.each(["editor", "git"] as const)("Common tab creation/navigation in %s never affects other screens", async mode => {
  // Agent/Terminal-specific commands cannot change inactive-screen selection.
  const app = await mount(mode);
  try {
    for (const key of ["c", "n", "p"]) app.leader(key);
    await app.render();

    expect(app.selection.sessionId).toBe("a1"); expect(app.requests).toEqual([]);
    expect(app.view.workViewPreferences.active["demo:main"]).toBe(mode); expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("Navigation never creates empty tabs and single tabs remain selected", async () => {
  // Browsing never implicitly creates sessions.
  const app = await mount();
  try {
    app.selection.selectWorktree("demo:feature"); await app.render();
    for (const key of ["n", "p"]) app.leader(key);
    expect(app.selection.sessionId).toBe("b1");
    app.selection.selectWorktree("demo:empty"); await app.render();
    for (const key of ["n", "p"]) app.leader(key);
    await app.render();

    expect(app.selection.sessionId).toBeNull(); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Overrides update common tab behavior, help, and footers", async () => {
  // Cycle using configured global commands, not hardcoded characters.
  const app = await mount("agent", true);
  try {
    app.mockInput.pressKey("k", { meta: true }); await app.render(); expect(app.active()).toBe("a3");
    app.mockInput.pressKey("j", { meta: true }); await app.render();
    expect(app.active()).toBe("a1"); expect(app.captureCharFrame()).toContain("<M-k>/<M-j> Tab");
    app.leader("?"); await app.render();
    app.mockInput.pressKey("d", { ctrl: true }); await app.render();

    expect(app.captureCharFrame()).toContain("<M-j>"); expect(app.requests).toEqual([]);
    expect(app.inputs).toEqual([]);
  } finally { await app.close(); }
});

test("Unprefixed n/p/c/d/u and native Ctrl+N/P never become app commands", async () => {
  // Shared leader commands preserve literal characters and native shell editing keys.
  const app = await mount("terminal");
  try {
    await app.mockInput.typeText("npcdu"); app.mockInput.pressKey("n", { ctrl: true }); app.mockInput.pressKey("p", { ctrl: true });
    await app.render();

    expect(app.inputs.join("")).toBe(Buffer.from("npcdu\x0e\x10").toString("hex"));
    expect(app.active()).toBe("shell-1"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});

test("Held tab-navigation repeats never replay as text in newly focused inputs", async () => {
  // Holding the final sequence key through tab switching must not insert n into drafts.
  const app = await mount();
  const raw = (sequence: string) => {
    const key = parseKeypress(sequence, { useKittyKeyboard: true }); if (!key) throw new Error("Invalid Kitty key");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    app.mockInput.pressKey(" ", { ctrl: true }); raw("\x1b[110u"); raw("\x1b[110;1:2u"); await app.render();

    expect(app.active()).toBe("a2"); expect(app.view.promptDrafts.a2).toBe("second draft");
    raw("\x1b[110;1:3u"); app.mockInput.pressKey("n");
    expect(app.view.promptDrafts.a2).toBe("second draftn"); expect(app.requests).toEqual([]);
  } finally { await app.close(); }
});
