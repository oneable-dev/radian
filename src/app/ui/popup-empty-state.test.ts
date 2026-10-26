import { expect, test } from "bun:test";
import { TextRenderable, type BoxRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { SessionMonitor } from "../../agents/ui/session-monitor.ts";
import { SessionHistoryPanel } from "../../agents/ui/history-panel.ts";
import { ModelPicker } from "../../agents/ui/model-picker.ts";
import { DashboardPanel } from "../../agents/ui/dashboard-panel.ts";
import { ExtensionDialogPanel } from "../../agents/ui/extension-dialog.ts";
import { AccountsPanel } from "../../accounts/panel.ts";
import { MessagesPanel } from "../../ui/messages-panel.ts";
import { Messages } from "../../ui/messages.ts";
import { TextDialog } from "../../ui/text-dialog.ts";
import { GitBrowser } from "../../git/ui/browser.ts";
import { Workbench } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { defaultKeymap } from "../../keybindings/config.ts";
import { emptyDashboard } from "../../agents/dashboard.ts";
import { InputError } from "../../errors.ts";
import { ok, err } from "../../result.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";

const surfaces = [
  { name: "workspace", body: "workspace-results", title: "No repositories" },
  { name: "monitor", body: "monitor-results", title: "No working sessions or unread results", preview: "monitor-preview-pane" },
  { name: "history", body: "history-results", title: "No saved sessions", preview: "history-preview-pane" },
  { name: "model", body: "model-results", title: "No available models" },
  { name: "messages", body: "messages-results", title: "No messages yet" },
  { name: "refs", body: "git-browser-results", title: "No matches" },
  { name: "reflog", body: "git-browser-results", title: "No matches", preview: "git-reflog-preview-pane" },
  { name: "changes", body: "git-files-body", title: "No changed", preview: "git-comparison-body" },
  { name: "accounts", body: "accounts-results", title: "No connected accounts" },
  { name: "extension", body: "extension-results", title: "No matching options" },
  { name: "dashboard", body: "dashboard-ranking-body", title: "No recorded usage" },
  { name: "text", body: "text-dialog-content", title: "No content" },
] as const;
type Surface = typeof surfaces[number]["name"];

async function mount(name: Surface, width: number, height: number) {
  const app = await createTestRenderer({ width, height, kittyKeyboard: true, clock: new ManualClock() });
  const hints = defaultKeymap(), hint = (command: CommandId, context: KeyContext) => hints.hint(command, context);
  const noop = () => {}, common = { changed: noop, fallback: noop, notice: noop, keyHint: hint };
  const tree = demoWorkspace()[0]!.worktrees[0]!;
  const snapshot = { commits: [], refs: [], reflog: [], files: [], head: "main", headOid: null };
  const render = async () => { for (let pass = 0; pass < 4; pass++) await app.renderOnce(); };
  let panel: { root: BoxRenderable; dispose(): void }, revealPreview = noop;
  if (name === "workspace") {
    panel = new Workbench(app.renderer, new WorkspaceSelection([]), { onNewSession: noop, onCloseSession: noop });
    await render(); app.mockInput.pressKey(" ", { ctrl: true }); app.mockInput.pressKey("b");
  } else if (name === "monitor") {
    const monitor = new SessionMonitor(app.renderer, { ...common, details: () => null, open: noop });
    panel = monitor; app.renderer.root.add(panel.root); monitor.update([]); monitor.show();
    revealPreview = () => monitor.command("monitor.preview");
  } else if (name === "history") {
    const history = new SessionHistoryPanel(app.renderer, { list: async () => ok([]), onOpened: noop, onError: noop, keyHint: hint });
    panel = history; app.renderer.root.add(panel.root); history.show(tree);
    revealPreview = () => history.command("history.preview");
  } else if (name === "model") {
    const model = new ModelPicker(app.renderer, { ...common, list: async () => ok({ conversationId: "conversation", current: null, effort: "off", models: [] }) });
    panel = model; app.renderer.root.add(panel.root); model.show({ sessionId: "session", conversationId: "conversation" });
  } else if (name === "messages") {
    const messages = new MessagesPanel(app.renderer, new Messages(), { changed: noop, fallback: noop, details: noop, copy: noop, hint });
    panel = messages; app.renderer.root.add(panel.root); messages.show();
  } else if (name === "refs" || name === "reflog") {
    const browser = new GitBrowser(app.renderer, { changed: noop, close: noop, selected: noop, filter: noop, open: noop, hint,
      inspect: async () => err(new InputError("No target in an empty fixture")) });
    panel = browser; app.renderer.root.add(panel.root); browser.show(name, snapshot, null);
    if (name === "refs") browser.search.value = "missing-ref";
    revealPreview = () => browser.command("git.preview");
  } else if (name === "changes") {
    const source = { load: async () => ok(snapshot), details: async () => err(new InputError("No commit in an empty fixture")),
      compare: async () => ok({ before: "", after: "", beforeLabel: "HEAD", afterLabel: "worktree" }) };
    panel = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), { onNewSession: noop, onCloseSession: noop, onPrompt: () => ok(undefined),
      getSessionDetails: () => ({ status: "complete", output: "", error: null }),
      git: { source: () => source, createSession: async () => ok("fixture"), prompt: () => ok(undefined) },
      initialWorkViews: { active: { [tree.id]: "git" }, agentScroll: {} } });
    await render(); app.renderer.root.findDescendantById("git-history")!.focus(); app.mockInput.pressEnter();
  } else if (name === "accounts") {
    const accounts = new AccountsPanel(app.renderer, { ...common, request: async () => ok({ kind: "catalog", catalog: {
      revision: 1, worktreeId: tree.id, accounts: [], providers: [], selections: {},
    } }) });
    panel = accounts; app.renderer.root.add(panel.root); accounts.show(tree.id);
  } else if (name === "extension") {
    const extension = new ExtensionDialogPanel(app.renderer, { ...common, answer: async () => ok(undefined) });
    panel = extension; app.renderer.root.add(panel.root); extension.update({ sessionId: "session", conversationId: "conversation",
      dialog: { id: "request", kind: "select", title: "Choose an option", options: ["Fixture option"] } });
    extension.search.value = "missing-option";
  } else if (name === "dashboard") {
    const dashboard = new DashboardPanel(app.renderer, { ...common, projects: () => [], load: async () => ok(emptyDashboard(7, 1767225600000)) });
    panel = dashboard; app.renderer.root.add(panel.root); dashboard.show();
  } else {
    const dialog = new TextDialog(app.renderer, noop, noop);
    panel = dialog; app.renderer.root.add(panel.root); dialog.show({ title: "Details", text: "" });
  }
  await render();
  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id); if (!node) throw new Error(`Missing ${id}`); return node;
  };
  return { ...app, get, render, revealPreview,
    async close() { panel.dispose(); await app.dispose(); } };
}

for (const [width, height] of [[140, 32], [60, 16]] as const) {
  test.each(surfaces)(`$name empty guidance is centered within its own body at ${width} columns`, async surface => {
    // Each feature supplies its own state while the shared body owns cell-accurate placement.
    const app = await mount(surface.name, width, height);
    const centered = (id: string, expected?: string) => {
      const body = app.get(id), title = app.get(`${id}-empty:title`), description = app.get(`${id}-empty:description`);
      if (!(title instanceof TextRenderable)) throw new Error("Missing empty-state title");
      expect(app.get(`${id}-empty`).visible).toBe(true);
      if (expected) expect(title.plainText).toContain(expected);
      const bottom = description.visible ? description.y + description.height : title.y + title.height;
      expect(Math.abs(title.x + title.width / 2 - body.x - body.width / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((title.y + bottom) / 2 - body.y - body.height / 2)).toBeLessThanOrEqual(1);
      const frame = app.captureCharFrame().split("\n");
      expect(frame[title.y]?.slice(title.x, title.x + title.width).trim()).toBe(title.plainText);
    };
    try {
      // Empty data and unmatched queries must not turn into disabled candidate rows.
      centered(surface.body, surface.title);
      if ("preview" in surface) {
        if (width < 100 && surface.name !== "changes") { app.revealPreview(); await app.render(); }
        centered(surface.preview);
      }

      // No selected history/model means no fake editing or effort controls in the empty body.
      if (surface.name === "history") {
        expect(app.get("history-preview-agent-view").visible).toBe(false);
        expect(app.captureCharFrame()).not.toContain("Read-only preview");
      }
      if (surface.name === "model") expect(app.get("model-effort").visible).toBe(false);
      if (surface.name === "accounts") expect(app.captureCharFrame()).toContain("+ Add account");
    } finally { await app.close(); }
  });
}
