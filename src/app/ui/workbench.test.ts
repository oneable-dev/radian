import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { demoWorkspace } from "../../workspace/demo.ts";
import type { Repository } from "../../workspace/model.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { workspaceIcons } from "./workspace-status.ts";
import { icons, spinnerFrames } from "../../icons.ts";
import { Workbench } from "./workbench.ts";

async function mount(
  repositories: readonly Repository[] = demoWorkspace(),
  options: { kittyKeyboard?: boolean; clock?: ManualClock } = {},
) {
  // CSI-u makes Escape unambiguous; a separate legacy-clock test covers its timeout.
  const setup = await createTestRenderer({
    width: 120,
    height: 24,
    kittyKeyboard: true,
    ...options,
  });
  const selection = new WorkspaceSelection(repositories);
  const requests: string[] = [];
  const view = new Workbench(setup.renderer, selection, {
    onNewSession: (id) => {
      requests.push(id);
    },
    onCloseSession: (treeId, sessionId) =>
      selection.replaceSnapshot(
        selection.snapshot.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((tree) =>
            tree.id === treeId
              ? {
                  ...tree,
                  sessions: tree.sessions.filter((session) => session.id !== sessionId),
                }
              : tree,
          ),
        })),
      ),
  });
  await setup.renderOnce();
  return {
    ...setup,
    selection,
    requests,
    view,
    async openWorkspaces() {
      openWorkspaceSearch(setup);
      await setup.renderOnce();
    },
    async openHistory() {
      setup.mockInput.pressKey(" ", { ctrl: true });
      setup.mockInput.pressKey("h");
      await setup.renderOnce();
    },
    async clickText(text: string): Promise<void> {
      if (text.startsWith(icons.folder) || text === "radian-empty" || text.startsWith("Search")) {
        openWorkspaceSearch(setup);
        setup.mockInput.pressCtrlC();
        await setup.renderOnce();
      } else if (setup.renderer.root.findDescendantById("workspace-picker")!.visible) {
        setup.mockInput.pressEscape();
        await setup.renderOnce();
      }
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      if (x < 0 || y < 0)
        throw new Error(`Visible text not found: ${text}\n${setup.captureCharFrame()}`);
      await setup.mockMouse.click(x, y);
      await setup.renderOnce();
    },
    tabFrame(id: string): string {
      const tab = setup.renderer.root.findDescendantById(
        `session:${selection.worktree!.id}:${id}`,
      )!;
      return setup
        .captureCharFrame()
        .split("\n")
        [tab.y]!.slice(tab.x, tab.x + tab.width);
    },
    treeFrame(): string {
      const tree = setup.renderer.root.findDescendantById("workspace-tree");
      if (!tree) throw new Error("Missing workspace viewport");
      return setup
        .captureCharFrame()
        .split("\n")
        .slice(tree.y, tree.y + tree.height)
        .map((line) => line.slice(tree.x, tree.x + tree.width))
        .join("\n");
    },
    async searchFor(query: string): Promise<void> {
      openWorkspaceSearch(setup);
      setup.mockInput.pressCtrlC();
      await setup.renderOnce();
      await setup.mockInput.typeText(query);
      await setup.renderOnce();
    },
    async close(): Promise<void> {
      view.dispose();
      await setup.dispose();
    },
  };
}

test("Mouse selection restores last sessions and central screens for worktrees", async () => {
  // The renderer uses actual terminal mouse parsing and a display-only fixture.
  const app = await mount();
  try {
    // Select A2, leave for B, and return to the main worktree.
    await app.clickText("a2");
    await app.clickText(`${icons.folder} radian-ui`);
    await app.clickText(`${icons.folder} radian`);

    // The central panel reflects restored A2, without replacing source metadata.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.tabFrame("a2")).toContain("a2");
  } finally {
    await app.close();
  }
});

test("Close keys choose previous sessions at the end and empty screens for final entries", async () => {
  // The close callback reports metadata removal, not a real agent shutdown.
  const app = await mount();
  try {
    // Select the last item and close each surviving selected item.
    pressLeader(app, "p");
    pressLeader(app, "x");
    await app.renderOnce();
    expect(app.selection.sessionId).toBe("a2");
    pressLeader(app, "x");
    await app.renderOnce();
    pressLeader(app, "x");
    await app.renderOnce();

    // The same central empty state offers an explicit action, not an automatic session.
    expect(app.selection.sessionId).toBeNull();
    expect(app.selection.worktree?.sessions).toHaveLength(0);
    expect(app.captureCharFrame()).toContain("No AI sessions");
    expect(app.renderer.root.findDescendantById("agent-session-list")!.visible).toBe(true);
    expect(app.captureCharFrame().split("\n")[23]).toContain("<leader>c New session");
  } finally {
    await app.close();
  }
});

test("Row close actions never accidentally select parent sessions", async () => {
  // A2 is selected; the close control belongs to the preceding A1 row.
  const app = await mount();
  try {
    await app.clickText("a2");
    const close = app.renderer.root.findDescendantById("close-session:a1");
    if (!close) throw new Error("Missing session tab close control");

    // Activate A1's visible close control, rather than selecting A1's tab.
    await app.mockMouse.click(close.x, close.y);
    await app.renderOnce();

    // Event propagation leaves the existing A2 selection unchanged.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.selection.worktree?.sessions.map((session) => session.id)).toEqual(["a2", "a3"]);
  } finally {
    await app.close();
  }
});

test("Empty-worktree creation sends requests without manipulating selection or open lists", async () => {
  // No sessions exist in the empty worktree before the user requests creation.
  const app = await mount();
  try {
    await app.clickText("radian-empty");
    const before = app.selection.snapshot;

    // The action crosses the host callback boundary without implementing OA-5.
    app.mockInput.pressKey(" ", { ctrl: true });
    app.mockInput.pressKey("c");
    await app.renderOnce();

    // No runtime, automatic selection or placeholder session was manufactured.
    expect(app.requests).toEqual(["demo:empty"]);
    expect(app.selection.snapshot).toBe(before);
    expect(app.selection.sessionId).toBeNull();
    expect(app.captureCharFrame()).toContain("No AI sessions");
  } finally {
    await app.close();
  }
});

test("History explains unsupported previews while preserving selection", async () => {
  // Workspace A stays selected while the modal presents an unavailable history provider.
  const app = await mount();
  try {
    // Opening history overlays navigation without changing workspace state.
    await app.openHistory();

    // No history or resume operation is implied by the placeholder.
    expect(app.captureCharFrame()).toContain("Session history is unavailable in this preview.");
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Leader navigation reveals offscreen sessions and preserves selection in compact terminals", async () => {
  // Long display-only data exceeds the viewport; no agent timers drive the UI.
  const fixture: Repository[] = [
    {
      id: "long-repo",
      name: "long-repo",
      worktrees: [
        {
          id: "long-tree",
          path: "/demo/long",
          name: "long",
          branch: "main",
          sessions: Array.from({ length: 40 }, (_, index) => ({
            id: `long-${index}`,
            name: `Long session ${index}`,
            status: null,
            subagents: [],
          })),
        },
      ],
    },
  ];
  const app = await mount(fixture);
  try {
    // Moving backward from the first tab wraps to the last without focusing its strip.
    pressLeader(app, "p");
    await app.renderOnce();
    await app.renderOnce();
    expect(app.selection.sessionId).toBe("long-39");
    expect(app.captureCharFrame()).toContain("long-39");
    expect(app.treeFrame()).not.toContain("long-39");
    app.resize(60, 12);
    await app.renderOnce();
    await app.renderOnce();

    // Fixed-width tabs keep the selected ID and right-aligned close control inside the viewport.
    expect(app.tabFrame("long-39")).toBe("  40. long-39   × ");
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.selection.sessionId).toBe("long-39");
  } finally {
    await app.close();
  }
});

test("Up arrows browse previous worktrees and only Enter restores their last sessions", async () => {
  const app = await mount();
  try {
    await app.clickText(`${icons.folder} radian-ui`);
    await app.openWorkspaces();
    app.mockInput.pressTab();
    app.mockInput.pressArrow("up");
    await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    app.mockInput.pressEnter();
    await app.renderOnce();

    expect(app.selection.worktree?.id).toBe("demo:main");
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Kind icons stay left while aggregated parent/child status appears in right session tabs", async () => {
  const app = await mount();
  try {
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${workspaceIcons.repository} radian [demo]`);
    expect(app.treeFrame()).toContain(`${workspaceIcons.worktree} radian`);
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain("UI review");
    expect(spinnerFrames.some((frame) => app.tabFrame("a1").includes(frame))).toBe(true);
    await app.clickText("a2");
    expect(app.tabFrame("a2")).not.toContain(workspaceIcons.complete);
    pressLeader(app, "3");
    await app.renderOnce();
    await app.renderOnce();
    expect(app.tabFrame("a3")).toContain(icons.failure);
    await app.clickText(`${icons.folder} radian-ui`);
    expect(app.tabFrame("b1")).toBe("  1. b1         × ");
  } finally {
    await app.close();
  }
});

test("Failures behind History update after closing regardless of selection", async () => {
  // B is selected while A1's working child is tracked in the display snapshot.
  const app = await mount();
  try {
    await app.clickText(`${icons.folder} radian-ui`);
    await app.openHistory();

    // A host snapshot reports failure while the tree is not being painted.
    app.selection.replaceSnapshot(
      app.selection.snapshot.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({
          ...tree,
          sessions: tree.sessions.map((session) =>
            session.id !== "a1"
              ? session
              : {
                  ...session,
                  subagents: session.subagents.map((agent) => ({
                    ...agent,
                    status: "failure" as const,
                  })),
                },
          ),
        })),
      })),
    );
    app.mockInput.pressEscape();
    await app.renderOnce();

    // The aggregate changes without selecting A or changing repository/worktree types.
    expect(app.selection.sessionId).toBe("b1");
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${workspaceIcons.worktree} radian`);
    await app.clickText(`${icons.folder} radian`);
    expect(app.tabFrame("a1")).toContain(icons.failure);
  } finally {
    await app.close();
  }
});

test("Tab and Shift+Tab move focus among visible input owners", async () => {
  // The tree is the initial focus target in the workspace sidebar.
  const app = await mount();
  try {
    const first = app.renderer.currentFocusedRenderable;

    // Focus cycling is explicit because Core has no automatic Tab traversal.
    app.mockInput.pressTab();
    const next = app.renderer.currentFocusedRenderable;
    app.mockInput.pressTab({ shift: true });

    // Keyboard-only navigation returns to the initial target without losing selection.
    expect(next).not.toBe(first);
    expect(app.renderer.currentFocusedRenderable).toBe(first);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Branch search filters only worktree lists while preserving right sessions and input focus", async () => {
  // The search starts empty and has no connection to an agent runtime.
  const app = await mount();
  try {
    const before = app.selection.snapshot;
    await app.openWorkspaces();
    const input = app.renderer.currentFocusedRenderable;

    // Mixed-case typing filters on INPUT, without Enter or blur.
    await app.mockInput.typeText("mAIN");
    await app.renderOnce();

    // Matching the branch keeps every child and the same focused input instance.
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.treeFrame()).not.toContain("UI review");
    expect(app.captureCharFrame()).toContain("a2");
    expect(app.treeFrame()).not.toContain("Sidebar prototype");
    expect(app.treeFrame()).not.toContain("radian-empty");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.snapshot).toBe(before);
  } finally {
    await app.close();
  }
});

test("Typing q/n/x in search never quits or executes session actions and Ctrl+C restores results", async () => {
  // The original selection should remain on screen even if the query hides its row.
  const app = await mount();
  try {
    const before = app.selection.snapshot;

    // These characters are text while the field is focused, not global commands.
    await app.searchFor("querynx");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    expect(app.selection.sessionId).toBe("a1");
    expect(app.selection.snapshot).toBe(before);
    expect(app.requests).toEqual([]);
    app.mockInput.pressCtrlC();
    await app.renderOnce();

    // Clearing restores the tree without creating, closing or selecting another session.
    expect(app.treeFrame()).toContain(`${icons.folder} radian-ui`);
    expect(app.treeFrame()).not.toContain("UI review");
    expect(app.captureCharFrame()).not.toContain("No matching workspaces");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Search deletion and paste update results while retaining input focus", async () => {
  // Adding a trailing character makes the main branch query miss.
  const app = await mount();
  try {
    await app.searchFor("mainx");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.captureCharFrame()).toContain("No matching workspaces");

    // Backspace restores the branch match; pasted text is another live input change.
    app.mockInput.pressBackspace();
    await app.renderOnce();
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    app.mockInput.pressCtrlC();
    await app.renderOnce();
    await app.mockInput.pasteBracketedText("FEATURE/EMPTY");
    await app.renderOnce();

    // The empty worktree appears as a search result without becoming the selected workspace.
    expect(app.treeFrame()).toContain("radian-empty");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Keyboard navigation after substring filtering selects only visible results", async () => {
  // The selected main session is hidden by a partial folder-name query.
  const app = await mount();
  try {
    await app.searchFor("IAN-UI");
    expect(app.selection.sessionId).toBe("a1");

    // Tab moves to candidates; Enter alone commits a workspace.
    app.mockInput.pressTab();
    app.mockInput.pressKey("END");
    app.mockInput.pressArrow("up");
    app.mockInput.pressArrow("up");
    await app.renderOnce();

    // Navigation does not commit selection, even when only one result remains.
    expect(app.selection.worktree?.id).toBe("demo:main");
    app.mockInput.pressEnter();
    await app.renderOnce();
    expect(app.selection.worktree?.id).toBe("demo:feature");
    expect(app.selection.sessionId).toBe("b1");
    await app.openWorkspaces();
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
    expect(app.treeFrame()).not.toContain("Workspace layout");
  } finally {
    await app.close();
  }
});

test("Closing filtered trees selects the next session from original lists", async () => {
  // The branch query keeps A1, A2 and A3 while another worktree remains hidden.
  const app = await mount();
  try {
    await app.searchFor("MAIN");

    // Only the explicit close command asks the demo host to remove display metadata.
    app.mockInput.pressEnter();
    pressLeader(app, "x");
    await app.renderOnce();

    // Canonical fallback and filtering remain separate; B's hidden session is untouched.
    expect(app.selection.sessionId).toBe("a2");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    expect(app.captureCharFrame()).toContain("a2");
    expect(
      app.selection.snapshot
        .flatMap((repo) => repo.worktrees)
        .find((tree) => tree.id === "demo:feature")?.sessions,
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Snapshots during search use current queries and hidden states reveal latest values after clearing", async () => {
  // A stays selected while the UI shows only B's matching worktree.
  const app = await mount();
  try {
    await app.searchFor("IAN-UI");
    const input = app.renderer.currentFocusedRenderable;

    // The host reports new visible metadata and a hidden child's failure; no SDK is involved.
    app.selection.replaceSnapshot(
      app.selection.snapshot.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((tree) => ({
          ...tree,
          sessions: tree.sessions.map((session) => {
            if (session.id === "a1")
              return {
                ...session,
                subagents: session.subagents.map((agent) => ({
                  ...agent,
                  status: "failure" as const,
                })),
              };
            if (session.id === "b1")
              return {
                ...session,
                subagents: [{ id: "fresh", name: "Fresh child", status: "working" as const }],
              };
            return session;
          }),
        })),
      })),
    );
    await app.renderOnce();
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
    expect(app.treeFrame()).not.toContain("Fresh child");
    expect(app.treeFrame()).not.toContain("Workspace layout");
    app.mockInput.pressCtrlC();
    await app.renderOnce();

    // Clearing search preserves selection/focus and shows session-specific failure icons.
    expect(app.tabFrame("a1")).toContain(icons.failure);
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Repository-name searches retain all worktrees and remain editable after Tab round-trips", async () => {
  // A partial repository-name query matches the complete demo subtree.
  const app = await mount();
  try {
    await app.searchFor("DIAN [DE");
    const input = app.renderer.currentFocusedRenderable;
    expect(app.treeFrame()).toContain("radian-empty");
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).toContain(`${icons.branch} feature/workspace`);

    // Moving focus away and back must not recreate or reset the search field.
    app.mockInput.pressTab();
    app.mockInput.pressTab({ shift: true });
    await app.mockInput.typeText("X");
    await app.renderOnce();

    // Appending at the retained cursor changes the query, rather than replacing it.
    expect(app.captureCharFrame()).toContain("DIAN [DEX");
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
  } finally {
    await app.close();
  }
});

test("Search and reset never create sessions on repository-free screens", async () => {
  // An empty source distinguishes missing repositories from a no-match projection.
  const app = await mount([]);
  try {
    await app.openWorkspaces();
    expect(app.captureCharFrame()).toContain("No repositories");

    // Search and clear remain safe without any selectable tree row.
    await app.searchFor("missing");
    expect(app.captureCharFrame()).toContain("No matching workspaces");
    app.mockInput.pressCtrlC();
    await app.renderOnce();

    // The empty workspace is unchanged and no new-session request was emitted.
    expect(app.captureCharFrame()).toContain("No repositories");
    expect(app.selection.worktree).toBeNull();
    expect(app.selection.snapshot).toEqual([]);
    expect(app.requests).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Compact resize preserves query/focus and allows continued result editing", async () => {
  // The focused field contains a short branch query that fits both viewport widths.
  const app = await mount();
  try {
    await app.searchFor("MAIN");
    const input = app.renderer.currentFocusedRenderable;

    // Resize changes layout, not input identity or canonical selection.
    app.resize(60, 12);
    await app.renderOnce();
    app.mockInput.pressBackspace();
    await app.renderOnce();

    // The edited query still matches main and the optional inspector gives way to the UI.
    expect(app.captureCharFrame()).toContain("MAI");
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.renderer.root.findDescendantById("agent-session-tabs")?.visible).toBe(true);
    expect(app.captureCharFrame()).not.toContain("Inspector");
    expect(app.renderer.currentFocusedRenderable).toBe(input);
    expect(app.selection.sessionId).toBe("a1");
  } finally {
    await app.close();
  }
});

test("Legacy Esc closes popups after the 20ms distinction window and preserves reopened input's first character", async () => {
  // A bare Escape is ambiguous with Alt-key input until Core's parser timeout.
  const clock = new ManualClock();
  const app = await mount(demoWorkspace(), { kittyKeyboard: false, clock });
  try {
    openWorkspaceSearch(app);
    await app.mockInput.typeText("missing");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("No matching workspaces");

    // Advance the actual parser clock instead of sleeping or changing product behavior.
    app.mockInput.pressEscape();
    clock.advance(20);
    await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("No matching workspaces");
    await app.openWorkspaces();
    app.mockInput.pressCtrlC();
    await app.mockInput.typeText("MAIN");
    await app.renderOnce();

    // The next query is not interpreted as an Alt-prefixed character sequence.
    expect(app.captureCharFrame()).toContain("MAIN");
    expect(app.treeFrame()).toContain(`${icons.branch} main`);
    expect(app.treeFrame()).not.toContain(`${icons.folder} radian-ui`);
  } finally {
    await app.close();
  }
});
