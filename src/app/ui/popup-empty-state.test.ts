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
import { SearchInput } from "../../ui/search-input.ts";

const surfaces = [
  {
    name: "workspace",
    preset: "standard",
    panel: "workspace-sidebar",
    content: "workspace-body",
    header: "Workspace",
    body: "workspace-results",
    title: "No repositories",
  },
  {
    name: "monitor",
    preset: "standard",
    panel: "monitor-dialog",
    content: "monitor-body",
    header: "AI Sessions",
    body: "monitor-results",
    title: "No working sessions or unread results",
  },
  {
    name: "history",
    preset: "expanded",
    panel: "history-dialog",
    content: "history-body",
    header: "History · radian",
    body: "history-results",
    title: "No saved sessions",
    preview: "history-preview-pane",
  },
  {
    name: "model",
    preset: "standard",
    panel: "model-dialog",
    content: "model-body",
    header: "Model & effort",
    body: "model-results",
    title: "No available models",
  },
  {
    name: "messages",
    preset: "standard",
    panel: "messages-panel",
    content: "messages-body",
    header: "Messages",
    body: "messages-results",
    title: "No messages yet",
  },
  {
    name: "refs",
    preset: "standard",
    panel: "git-browser-panel",
    content: "git-browser-body",
    header: "Refs",
    body: "git-browser-results",
    title: "No matches",
  },
  {
    name: "reflog",
    preset: "expanded",
    panel: "git-browser-panel",
    content: "git-browser-body",
    header: "Reflog",
    body: "git-browser-results",
    title: "No matches",
    preview: "git-reflog-preview-pane",
  },
  {
    name: "changes",
    panel: "git-changes",
    content: "git-changes-body",
    header: "Working tree",
    body: "git-files-body",
    title: "No changed",
    preview: "git-comparison-body",
  },
  {
    name: "accounts",
    preset: "standard",
    panel: "accounts-dialog",
    content: "accounts-body",
    header: "Accounts",
    body: "accounts-results",
    title: "No connected accounts",
  },
  {
    name: "extension",
    preset: "standard",
    panel: "extension-dialog-panel",
    content: "extension-dialog-details",
    header: "Extension ·",
    body: "extension-results",
    title: "No matching options",
  },
  {
    name: "dashboard",
    panel: "dashboard-panel",
    content: "dashboard-body",
    header: "Agent Dashboard",
    body: "dashboard-ranking-body",
    title: "No recorded usage",
  },
  {
    name: "text",
    preset: "expanded",
    panel: "text-dialog-panel",
    content: "text-dialog-content",
    header: "Details",
    body: "text-dialog-content",
    title: "No content",
  },
] as const;

type Surface = (typeof surfaces)[number]["name"];

const searches: Partial<
  Record<Surface, { id: string; title: string; counts: string; status?: string }>
> = {
  workspace: { id: "workspace-search", title: "Workspaces", counts: "0/0" },
  monitor: { id: "monitor-search", title: "Sessions", counts: "0/0", status: "monitor-message" },
  history: { id: "history-search", title: "History", counts: "0/0", status: "history-list-status" },
  model: { id: "model-search", title: "Models", counts: "0/0", status: "model-message" },
  messages: { id: "messages-search", title: "Messages", counts: "0/0" },
  refs: { id: "git-browser-search", title: "Refs", counts: "0/1", status: "git-browser-status" },
  reflog: {
    id: "git-browser-search",
    title: "Reflog",
    counts: "0/0",
    status: "git-browser-status",
  },
  accounts: { id: "accounts-search", title: "Accounts", counts: "1/1", status: "accounts-message" },
  extension: { id: "extension-dialog-search", title: "Choose an option", counts: "0/1" },
};

async function mount(name: Surface, width: number, height: number) {
  const app = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
    clock: new ManualClock(),
  });
  const hints = defaultKeymap();
  const hint = (command: CommandId, context: KeyContext) => hints.hint(command, context);
  const noop = () => {};
  const common = { changed: noop, fallback: noop, notice: noop, keyHint: hint };
  const tree = demoWorkspace()[0]!.worktrees[0]!;
  const snapshot = { commits: [], refs: [], reflog: [], files: [], head: "main", headOid: null };
  const render = async () => {
    for (let pass = 0; pass < 4; pass++) {
      await app.renderOnce();
    }
  };
  let panel: { root: BoxRenderable; dispose(): void };
  let revealPreview = noop;
  let revealEmpty = noop;
  if (name === "workspace") {
    panel = new Workbench(app.renderer, new WorkspaceSelection([]), {
      onNewSession: noop,
      onCloseSession: noop,
    });
    await render();
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("b");
  } else if (name === "monitor") {
    const monitor = new SessionMonitor(app.renderer, {
      ...common,
      details: () => null,
      open: noop,
    });
    panel = monitor;
    app.renderer.root.add(panel.root);
    monitor.update([]);
    monitor.show();
  } else if (name === "history") {
    const history = new SessionHistoryPanel(app.renderer, {
      list: async () => ok([]),
      onOpened: noop,
      onError: noop,
      keyHint: hint,
    });
    panel = history;
    app.renderer.root.add(panel.root);
    history.show(tree);
    revealPreview = () => history.command("history.preview");
  } else if (name === "model") {
    const model = new ModelPicker(app.renderer, {
      ...common,
      list: async () =>
        ok({ conversationId: "conversation", current: null, effort: "off", models: [] }),
    });
    panel = model;
    app.renderer.root.add(panel.root);
    model.show({ sessionId: "session", conversationId: "conversation" });
  } else if (name === "messages") {
    const messages = new MessagesPanel(app.renderer, new Messages(), {
      changed: noop,
      fallback: noop,
      details: noop,
      copy: noop,
      hint,
    });
    panel = messages;
    app.renderer.root.add(panel.root);
    messages.show();
  } else if (name === "refs" || name === "reflog") {
    const browser = new GitBrowser(app.renderer, {
      changed: noop,
      close: noop,
      selected: noop,
      filter: noop,
      open: noop,
      hint,
      inspect: async () => err(new InputError("No target in an empty fixture")),
    });
    panel = browser;
    app.renderer.root.add(panel.root);
    browser.show(name, snapshot, null);
    if (name === "refs") {
      browser.search.value = "missing-ref";
    }

    revealPreview = () => browser.command("git.preview");
  } else if (name === "changes") {
    const source = {
      load: async () => ok(snapshot),
      details: async () => err(new InputError("No commit in an empty fixture")),
      compare: async () =>
        ok({ before: "", after: "", beforeLabel: "HEAD", afterLabel: "worktree" }),
    };
    panel = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
      onNewSession: noop,
      onCloseSession: noop,
      onPrompt: () => ok(undefined),
      getSessionDetails: () => ({ status: "complete", output: "", error: null }),
      git: {
        source: () => source,
        createSession: async () => ok("fixture"),
        prompt: () => ok(undefined),
      },
      initialWorkViews: { active: { [tree.id]: "git" }, agentScroll: {} },
    });
    await render();
    app.renderer.root.findDescendantById("git-history")!.focus();
    app.mockInput.pressEnter();
  } else if (name === "accounts") {
    const accounts = new AccountsPanel(app.renderer, {
      ...common,
      request: async () =>
        ok({
          kind: "catalog",
          catalog: {
            revision: 1,
            worktreeId: tree.id,
            accounts: [],
            providers: [],
            selections: {},
          },
        }),
    });
    panel = accounts;
    app.renderer.root.add(panel.root);
    accounts.show(tree.id);
  } else if (name === "extension") {
    const extension = new ExtensionDialogPanel(app.renderer, {
      ...common,
      answer: async () => ok(undefined),
    });
    panel = extension;
    app.renderer.root.add(panel.root);
    extension.update({
      sessionId: "session",
      conversationId: "conversation",
      dialog: {
        id: "request",
        kind: "select",
        title: "Choose an option",
        options: ["Fixture option"],
      },
    });
    extension.search.value = "missing-option";
  } else if (name === "dashboard") {
    const dashboard = new DashboardPanel(app.renderer, {
      ...common,
      projects: () => [],
      load: async () => ok(emptyDashboard(7, 1767225600000)),
    });
    panel = dashboard;
    app.renderer.root.add(panel.root);
    dashboard.show();
    revealEmpty = () => dashboard.focusTargets.at(-1)!.focus();
  } else {
    const dialog = new TextDialog(app.renderer, noop, noop);
    panel = dialog;
    app.renderer.root.add(panel.root);
    dialog.show({ title: "Details", text: "" });
  }

  await render();

  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };

  return {
    ...app,
    get,
    render,
    revealPreview,
    revealEmpty,
    async close() {
      panel.dispose();
      await app.dispose();
    },
  };
}

test.each(surfaces.filter((surface) => "preset" in surface))(
  "$name uses shared popup sizes without resetting search or focus",
  async (surface) => {
    // Centered surfaces share one size per role, independently of empty results or search queries.
    const app = await mount(surface.name, 320, 90);
    const searchId = searches[surface.name]?.id;
    const search = searchId ? (app.get(searchId) as SearchInput) : undefined;
    const focus = app.renderer.currentFocusedRenderable;
    try {
      const panel = app.get(surface.panel);
      const expanded = surface.preset === "expanded";
      const geometry = [panel.x, panel.y, panel.width, panel.height];

      // Filtering must not shrink the frame or move the input caret.
      if (search) {
        search.value = "no-match-hjkl";
        search.cursorOffset = 3;
      }

      await app.render();

      expect([panel.x, panel.y, panel.width, panel.height]).toEqual(geometry);
      for (const [width, height, columns, rows] of [
        [320, 90, expanded ? 160 : 100, expanded ? 36 : 24],
        [140, 32, expanded ? 126 : 100, expanded ? 25 : 24],
        [60, 16, 54, 12],
        [30, 10, 27, 8],
        [320, 90, expanded ? 160 : 100, expanded ? 36 : 24],
      ] as const) {
        // Repeated shrink/grow cycles use current bounds rather than stale native geometry.
        app.resize(width, height);
        await app.render();

        expect([panel.width, panel.height]).toEqual([columns, rows]);
        expect(panel.x).toBe(Math.floor((width - columns) / 2));
        expect(panel.y).toBe(Math.floor((height - rows) / 2));
        expect(app.renderer.currentFocusedRenderable).toBe(focus);
        if (search) {
          expect(search.value).toBe("no-match-hjkl");
          expect(search.cursorOffset).toBe(3);
        }
      }
    } finally {
      await app.close();
    }
  },
);

for (const [width, height] of [
  [140, 32],
  [60, 16],
] as const) {
  test.each(surfaces)(
    `$name popups have no title row and center empty guidance at ${width} columns`,
    async (surface) => {
      // Each feature supplies its own state while the shared body owns cell-accurate placement.
      const app = await mount(surface.name, width, height);
      const centered = (id: string, expected?: string) => {
        const body = app.get(id);
        const title = app.get(`${id}-empty:title`);
        const description = app.get(`${id}-empty:description`);
        if (!(title instanceof TextRenderable)) {
          throw new Error("Missing empty-state title");
        }

        expect(app.get(`${id}-empty`).visible).toBe(true);
        if (expected) {
          expect(title.plainText).toContain(expected);
        }

        const bottom = description.visible
          ? description.y + description.height
          : title.y + title.height;
        expect(Math.abs(title.x + title.width / 2 - body.x - body.width / 2)).toBeLessThanOrEqual(
          0.5,
        );
        expect(Math.abs((title.y + bottom) / 2 - body.y - body.height / 2)).toBeLessThanOrEqual(1);

        const frame = app.captureCharFrame().split("\n");
        expect(frame[title.y]?.slice(title.x, title.x + title.width).trim()).toBe(title.plainText);
      };
      try {
        // Content starts at the first available row, with no hidden or reserved title row.
        const panel = app.get(surface.panel);
        const content = app.get(surface.content);
        const spec = searches[surface.name];

        expect(content.y).toBe(panel.y + (spec || surface.name === "dashboard" ? 0 : 1));

        const popupText = app
          .captureCharFrame()
          .split("\n")
          .slice(panel.y, panel.y + panel.height)
          .map((line) => line.slice(panel.x, panel.x + panel.width))
          .join("\n");
        if (spec) {
          // Shared picker chrome identifies the surface without placeholder text or a dedicated title row.
          const input = app.get(spec.id);
          if (!(input instanceof SearchInput)) {
            throw new Error("Missing shared search");
          }

          const body = app.get(surface.body);
          const list = body.getChildren()[0]!;
          const status = spec.status ? app.get(spec.status) : undefined;

          expect(input.field.title).toBe(` ${spec.title} `);
          expect(input.placeholder).toBe("");
          expect(app.captureCharFrame().split("\n")[input.field.y]).toContain(spec.title);
          expect((app.get(`${spec.id}-prompt`) as TextRenderable).plainText).toBe(">");
          expect((app.get(`${spec.id}-count`) as TextRenderable).plainText).toBe(spec.counts);
          expect(list.x).toBe(body.x + 1);
          expect(list.width).toBe(body.width - 2);
          expect(body.y).toBe(
            input.field.y + input.field.height + (status?.visible ? status.height : 0),
          );
        } else {
          expect(popupText).not.toContain(surface.header);
        }

        if (surface.name === "dashboard") {
          // Live resources precede usage history; focusing its category reveals the empty ranking.
          expect(app.get("dashboard-resources").y).toBe(content.y);
          expect(popupText).toContain("Radian resources");
          expect(app.get("dashboard-period").y).toBeGreaterThan(content.y);
          app.revealEmpty();
          await app.render();
        }

        // Empty data and unmatched queries must not turn into disabled candidate rows.
        centered(surface.body, surface.title);
        if ("preview" in surface) {
          if (width < 100 && surface.name !== "changes") {
            app.revealPreview();
            await app.render();
          }

          centered(surface.preview);
        }

        // No selected history/model means no fake editing or effort controls in the empty body.
        if (surface.name === "history") {
          expect(app.get("history-preview-agent-view").visible).toBe(false);
          expect(app.captureCharFrame()).not.toContain("Read-only preview");
        }
        if (surface.name === "model") {
          expect(app.get("model-effort").visible).toBe(false);
        }
        if (surface.name === "accounts") {
          expect(app.captureCharFrame()).toContain("+ Add account");
        }
      } finally {
        await app.close();
      }
    },
  );
}
