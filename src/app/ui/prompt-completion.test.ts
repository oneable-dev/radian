import { openWorkspaceSearch, pressLeader } from "../../testing/keys.ts";
import { expect, test } from "bun:test";
import { parseKeypress, ScrollBoxRenderable } from "@opentui/core";
import { resolve } from "node:path";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { Workbench, type WorkbenchActions } from "./workbench.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import {
  filterCatalog,
  filterCompletions,
  type CompletionItem,
  type CompletionResult,
} from "../../agents/completion.ts";
import type { CompletionProvider } from "../../agents/ui/completion-menu.ts";
import { CapabilityError, InputError } from "../../errors.ts";
import { err, ok } from "../../result.ts";
import { uiTheme } from "../../ui/theme.ts";

const commandItems = ["mcp", "memory"].map((value) => ({
  kind: "command" as const,
  value,
  description: `Command ${value}`,
}));
const fileItems = ["src/main.ts", "src/문서 file.ts"].map((value) => ({
  kind: "file" as const,
  value,
  description: "Worktree file",
}));
async function mount(
  provider: CompletionProvider = async (_id, query) =>
    ok(filterCompletions(query.kind === "file" ? fileItems : commandItems, query.query)),
  submit?: NonNullable<WorkbenchActions["onPrompt"]>,
) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true, clock });
  const selection = new WorkspaceSelection(demoWorkspace());
  const sent: string[] = [];
  let output = "Streaming transcript";
  const view = new Workbench(app.renderer, selection, {
    onNewSession: () => {},
    onCloseSession: () => {},
    onPrompt: (id, text, images) => {
      sent.push(text);
      return submit ? submit(id, text, images) : ok(undefined);
    },
    onComplete: provider,
    getSessionDetails: () => ({ status: "working", output, error: null }),
  });
  const render = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await app.renderOnce();
    await app.renderOnce();
  };
  await render();
  pressLeader(app, "a");
  await render();
  const input = app.renderer.root.findDescendantById("session-prompt") as PromptInput;
  const complete = async () => {
    await render();
    clock.advance(150);
    await render();
  };
  return {
    ...app,
    clock,
    selection,
    view,
    input,
    sent,
    render,
    complete,
    menu: () => app.renderer.root.findDescendantById("prompt-completions")!,
    async type(text: string) {
      await app.mockInput.typeText(text);
      await complete();
    },
    async stream(text: string) {
      output = text;
      selection.replaceSnapshot(selection.snapshot);
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Command completion shows prefix matches only, excluding middle substrings", async () => {
  // The menu contains mcp, whose suffix must not become an executable candidate.
  const app = await mount();
  try {
    await app.type("/cp");

    // Editing within the same menu must immediately apply the prefix policy.
    expect(app.captureCharFrame()).toContain("No matches");
    app.input.value = "/mc";
    await app.complete();

    // Candidate discovery preserves the draft and does not submit a command.
    expect(app.captureCharFrame()).toContain("Command mcp");
    expect(app.input.value).toBe("/mc");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["/", "$", "@"] as const)(
  "Prepared %s catalogs display immediately without clock waits, loading, or extra queries",
  async (trigger) => {
    // Prepared caches need no further server or filesystem reads.
    const items: readonly CompletionItem[] = [
      { kind: "command", value: "compact", description: "Compact context" },
      { kind: "skill", value: "skill:review-code", description: "Review code" },
      { kind: "file", value: "docs/reference.ts", description: "Reference file" },
    ];
    let requests = 0,
      reads = 0;
    const provider: CompletionProvider = Object.assign(
      async () => {
        requests++;
        return ok({ items, truncated: false });
      },
      {
        read: (_id: string, query: Parameters<CompletionProvider>[1]) => {
          reads++;
          return ok(
            query.kind === "file"
              ? filterCompletions(
                  items.filter((item) => item.kind === "file"),
                  query.query,
                )
              : filterCatalog(items, query),
          );
        },
      },
    );
    const app = await mount(provider);
    try {
      // Initial typing displays current-kind candidates without advancing timers.
      await app.mockInput.typeText(trigger);
      await app.render();

      const expected =
        trigger === "/" ? "compact" : trigger === "$" ? "review-code" : "docs/reference.ts";
      expect(app.menu().visible).toBe(true);
      expect(app.captureCharFrame()).toContain(`→ ${expected}`);
      expect(app.renderer.root.findDescendantById("completion-loading")!.visible).toBe(false);
      expect(app.captureCharFrame()).not.toContain("Loading");
      expect(requests).toBe(0);
      const before = reads;
      await app.stream("More background output");
      expect(reads).toBe(before);
      app.mockInput.pressTab();
      await app.render();

      expect(app.input.value).toBe(trigger === "@" ? "[File #1] " : `${trigger}${expected} `);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test.each([
  { trigger: "/", width: 120 },
  { trigger: "@", width: 120 },
  { trigger: "$", width: 120 },
  { trigger: "/", width: 80 },
  { trigger: "@", width: 80 },
  { trigger: "$", width: 80 },
  { trigger: "/", width: 60 },
  { trigger: "@", width: 60 },
  { trigger: "$", width: 60 },
] as const)(
  "At %j, completion arrows align with input origins across selection changes",
  async ({ trigger, width }) => {
    // Menu kinds and panel padding must not add extra input indentation.
    const items: readonly CompletionItem[] = [
      { kind: "command", value: "clear", description: "Clear conversation" },
      { kind: "command", value: "compact", description: "Compact context" },
      { kind: "skill", value: "skill:review-code", description: "Review code" },
      { kind: "skill", value: "skill:write-tests", description: "Write tests" },
      { kind: "file", value: "a.ts", description: "First file" },
      { kind: "file", value: "b.ts", description: "Second file" },
    ];
    const provider: CompletionProvider = Object.assign(
      async () => ok({ items, truncated: false }),
      {
        read: (_id: string, query: Parameters<CompletionProvider>[1]) =>
          ok(
            query.kind === "file"
              ? filterCompletions(
                  items.filter((item) => item.kind === "file"),
                  query.query,
                )
              : filterCatalog(items, query),
          ),
      },
    );
    const app = await mount(provider);
    const arrowColumn = (row: number) => {
      const line = app.captureCharFrame().split("\n")[row]!;
      expect(line).toContain("→ ");
      return Bun.stringWidth(line.slice(0, line.indexOf("→ ")));
    };
    try {
      // Render input and menu together before selecting the next candidate.
      app.resize(width, 24);
      await app.render();
      await app.mockInput.typeText(trigger);
      await app.render();
      const first = app.renderer.root.findDescendantById("completion-option-0")!;

      expect(first.x).toBe(app.input.x);
      expect(arrowColumn(first.y)).toBe(app.input.x);
      app.mockInput.pressKey("n", { ctrl: true });
      await app.render();
      const second = app.renderer.root.findDescendantById("completion-option-1")!;
      expect(second.x).toBe(app.input.x);
      expect(arrowColumn(second.y)).toBe(app.input.x);
      expect(app.input.value).toBe(trigger);
      expect(app.input.cursorOffset).toBe(1);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Watcher refreshes update candidates for unchanged queries while retaining selected items", async () => {
  // Watcher and reload events refresh open menus without retyping.
  let items: readonly CompletionItem[] = ["command-a", "command-b"].map((value) => ({
    kind: "command",
    value,
    description: "Command",
  }));
  let changed: (() => void) | undefined;
  const provider: CompletionProvider = Object.assign(async () => ok({ items, truncated: false }), {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) =>
      ok(filterCatalog(items, query)),
    subscribe: (listener: () => void) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  });
  const app = await mount(provider);
  try {
    await app.mockInput.typeText("/");
    await app.render();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    // Preserve selections by item name, not index, when earlier items appear.
    items = [{ kind: "command", value: "command-0", description: "New" }, ...items];
    changed?.();
    await app.render();

    expect(app.captureCharFrame()).toContain("→ command-b");
    expect(app.menu().height).toBe(3);
    app.mockInput.pressTab();
    await app.render();
    expect(app.input.value).toBe("/command-b ");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
    expect(changed).toBeUndefined();
  }
});

test("Enter during cache reload never executes stale catalog commands", async () => {
  // Old candidates are not current between invalidation and replacement arrival.
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  let ready = true,
    changed: (() => void) | undefined;
  let items: readonly CompletionItem[] = [
    { kind: "command", value: "compact", description: "Old command" },
  ];
  const provider: CompletionProvider = Object.assign(async () => pending.promise, {
    read: (_id: string, query: Parameters<CompletionProvider>[1]) =>
      ready ? ok(filterCatalog(items, query)) : undefined,
    subscribe: (listener: () => void) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  });
  const app = await mount(provider);
  try {
    await app.mockInput.typeText("/co");
    await app.render();

    // Enter on invalidated caches never immediately submits old commands.
    ready = false;
    changed?.();
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.sent).toEqual([]);
    items = [{ kind: "command", value: "compare", description: "New command" }];
    ready = true;
    changed?.();
    pending.resolve(ok({ items, truncated: false }));
    await app.render();

    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/co");
    expect(app.captureCharFrame()).toContain("→ compare");
  } finally {
    pending.resolve(ok({ items: [], truncated: false }));
    await app.close();
  }
});

test("Skills are excluded from slash suggestions and selectable only through dollar syntax", async () => {
  // Legacy single-catalog providers must not mix commands and skills in UI.
  const app = await mount(async () =>
    ok({
      items: [
        { kind: "command", value: "compact", description: "Compact context" },
        { kind: "skill", value: "skill:review-code", description: "Review fixture" },
      ],
      truncated: false,
    }),
  );
  try {
    await app.type("/");
    expect(app.captureCharFrame()).toContain("→ compact");
    expect(app.captureCharFrame()).not.toContain("Review fixture");

    // Dollar selection exposes a separate entry point without removing existing skills.
    app.input.value = "$rev";
    await app.complete();
    expect(app.captureCharFrame()).toContain("→ review-code");
    expect(app.captureCharFrame()).not.toContain("Compact context");
    app.mockInput.pressEnter();
    await app.render();

    expect(app.sent).toEqual(["$review-code"]);
    expect(app.input.value).toBe("");
  } finally {
    await app.close();
  }
});

test("Closed slash menus use no space and open heights track lookup state and result counts", async () => {
  // Many, single, empty, and failed results dynamically use the same input-adjacent space.
  const items = [
    { kind: "command" as const, value: "compact", description: "Compact context" },
    { kind: "command" as const, value: "model", description: "Select model" },
    ...Array.from({ length: 92 }, (_, i) => ({
      kind: "command" as const,
      value: `fixture-${i}`,
      description: "Fixture command",
    })),
  ];
  const app = await mount(async (_id, query) =>
    query.query === "error"
      ? err(new CapabilityError("Lookup failed"))
      : ok(filterCompletions(items, query.query)),
  );
  const geometry = () => [
    app.input.y,
    app.renderer.root.findDescendantById("session-transcript")!.height,
  ];
  try {
    const closed = geometry(),
      composer = app.renderer.root.findDescendantById("agent-composer")!;
    const metadata = app.renderer.root.findDescendantById("session-status")!;
    expect(app.menu().visible).toBe(false);
    expect(metadata.y).toBe(composer.y + composer.height);

    // Slash starts with one loading row, then expands to five candidates and position hints.
    app.mockInput.pressKey("/");
    await app.render();
    expect(app.menu().height).toBe(1);
    app.clock.advance(150);
    await app.render();

    const menu = app.menu();
    const lines = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(menu.y, menu.y + menu.height);
    expect(menu.y).toBe(composer.y + composer.height);
    expect(menu.height).toBe(6);
    expect(lines()[0]).toContain("→ compact");
    expect(lines().at(-1)).toContain("(1/94)");
    expect(lines().join("\n")).not.toContain("Commands · SDK resources");

    // Narrowed and empty searches immediately reclaim unused candidate rows.
    app.input.value = "/model";
    await app.complete();
    expect(menu.height).toBe(1);
    expect(lines()[0]).toContain("→ model");
    app.input.value = "/nomatch";
    await app.complete();
    expect(menu.height).toBe(1);
    expect(lines()[0]).toContain("No matches");
    app.input.value = "/error";
    await app.complete();
    expect(menu.height).toBe(1);
    expect(lines()[0]).toContain("Lookup failed");
    app.mockInput.pressEscape();
    await app.render();

    // Closed menus leave no blank rows and restore input/conversation heights.
    expect(menu.visible).toBe(false);
    expect(metadata.y).toBe(composer.y + composer.height);
    expect(geometry()).toEqual(closed);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  "Completion aligns commands/descriptions by cells and marks selection with arrows and text colors: light=%j",
  async (light) => {
    // Korean and combined emoji commands retain aligned descriptions and click targets.
    const items = [
      { kind: "template" as const, value: "guide:문서👩🏽‍💻", description: "Document guide" },
      { kind: "command" as const, value: "model", description: "Select model" },
    ];
    const app = await mount(async () => ok({ items, truncated: false }));
    const cell = (x: number, y: number) => {
      let column = 0;
      return app.captureSpans().lines[y]!.spans.find((span) => {
        column += span.width;
        return column > x;
      })!;
    };
    try {
      uiTheme(app.renderer).configure({
        palette: [],
        defaultForeground: light ? "#202020" : "#EEEEEE",
        defaultBackground: light ? "#FFFFFF" : "#101010",
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightForeground: null,
        highlightBackground: null,
      });

      // Place both candidates directly below input without titles or empty rows.
      await app.type("/");
      app.clock.advance(500);
      await app.render();

      const menu = app.menu(),
        lines = app.captureCharFrame().split("\n"),
        first = lines[menu.y]!,
        second = lines[menu.y + 1]!;
      const descriptionX = Bun.stringWidth(first.slice(0, first.indexOf("Document guide")));
      expect(menu.height).toBe(2);
      expect(first).toContain("→ guide:문서👩🏽‍💻");
      expect(descriptionX).toBe(Bun.stringWidth(second.slice(0, second.indexOf("Select model"))));
      const colors = uiTheme(app.renderer).colors;
      expect(cell(menu.x, menu.y).fg.toInts()).toEqual(colors.accent.toInts());
      expect(cell(descriptionX, menu.y + 1).fg.toInts()).toEqual(colors.muted.toInts());
      for (const y of [menu.y, menu.y + 1])
        expect(cell(descriptionX, y).bg.toInts()).toEqual(colors.panel.toInts());

      // Clicking only inserts and preserves input focus and submission contracts.
      await app.mockMouse.click(menu.x + 4, menu.y + 1);
      await app.render();
      expect(app.input.value).toBe("/model ");
      expect(app.menu().visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Large completion lists resize visible rows, scroll selection, and reclaim space on close", async () => {
  // Limit visible rows without truncating the underlying candidate catalog.
  const items = Array.from({ length: 20 }, (_, i) => ({
    kind: "command" as const,
    value: `command-${i}`,
    description: "Command description",
  }));
  const app = await mount(async () => ok({ items, truncated: true }));
  try {
    await app.type("/");

    // Off-page selections move visible candidates and position hints together.
    for (let i = 0; i < 7; i++) app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const page = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(app.menu().y, app.menu().y + app.menu().height)
        .join("\n");
    expect(page()).toContain("→ command-7");
    expect(page()).toContain("(8/20+)");

    // Compact layouts preserve selection/drafts without covering input, information, or footer.
    app.resize(60, 11);
    await app.render();
    const footer = app.renderer.root.findDescendantById("app-footer")!;
    expect(page()).toContain("→ command-7");
    expect(app.menu().y + app.menu().height).toBeLessThanOrEqual(footer.y);
    const height = app.menu().height;
    for (let i = 0; i < 6; i++) {
      await app.render();
      expect(app.menu().height).toBe(height);
    }
    app.resize(120, 24);
    await app.render();
    expect(app.menu().height).toBe(6);
    expect(page()).toContain("(8/20+)");
    app.mockInput.pressTab();
    await app.render();

    expect(app.input.value).toBe("/command-7 ");
    expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Completion height changes preserve historical first rows, scroll, and input focus", async () => {
  // Expanding menus adjusts only transcript viewports, not reading positions.
  const items = Array.from({ length: 20 }, (_, i) => ({
    kind: "command" as const,
    value: `command-${i}`,
    description: "Command",
  }));
  const app = await mount(async (_id, query) => ok(filterCompletions(items, query.query)));
  try {
    await app.stream(Array.from({ length: 80 }, (_, i) => `HISTORY_${i}`).join("\n"));
    const scroll = app.renderer.root.findDescendantById("session-transcript");
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("Missing transcript viewport");
    scroll.scrollTo(12);
    await app.render();
    const first = () =>
      app
        .captureCharFrame()
        .split("\n")
        .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
        .join("\n")
        .match(/HISTORY_\d+/u)?.[0];
    const before = first(),
      top = scroll.scrollTop;
    expect(before).toBeDefined();
    expect(app.view.workViewPreferences.agentViews?.a1?.follow).toBe(false);

    // Narrowing to one candidate and closing retain the same visible history.
    await app.type("/");
    expect(app.menu().height).toBe(6);
    expect(first()).toBe(before);
    expect(scroll.scrollTop).toBe(top);
    app.input.value = "/command-19";
    await app.complete();
    expect(app.menu().height).toBe(1);
    expect(first()).toBe(before);
    expect(scroll.scrollTop).toBe(top);
    app.mockInput.pressEscape();
    await app.render();

    expect(first()).toBe(before);
    expect(scroll.scrollTop).toBe(top);
    expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Rapid input queries once 150ms after the final edit while input/caret update immediately", async () => {
  const queries: string[] = [];
  const app = await mount(async (_id, query) => {
    queries.push(query.query);
    return ok({ items: fileItems, truncated: false });
  });
  try {
    // Separate input turns must still share a trailing debounce window.
    app.mockInput.pressKey("@");
    await app.render();
    app.clock.advance(50);
    app.mockInput.pressKey("a");
    await app.render();
    app.clock.advance(50);
    app.mockInput.pressKey("b");
    await app.render();
    expect(app.input.value).toBe("@ab");
    expect(app.input.cursorOffset).toBe(3);
    expect(queries).toEqual([]);
    app.clock.advance(149);
    await app.render();
    expect(queries).toEqual([]);
    app.clock.advance(1);
    await app.render();
    expect(queries).toEqual(["ab"]);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Refresh preserves existing candidate height, selection, and footer without committing stale results", async () => {
  const pending: ReturnType<
    typeof Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>
  >[] = [];
  const items = Array.from({ length: 10 }, (_, index) => ({
    kind: "file" as const,
    value: `abcdef-${index}.ts`,
    description: "File",
  }));
  const app = await mount(async () => {
    const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
    pending.push(gate);
    return gate.promise;
  });
  const geometry = () => [
    app.menu().height,
    app.renderer.root.findDescendantById("agent-composer")!.y,
    app.renderer.root.findDescendantById("session-transcript")!.height,
  ];
  const footer = () => app.captureCharFrame().split("\n")[app.renderer.height - 1]!;
  try {
    await app.type("@");
    expect(app.menu().height).toBe(1);
    pending[0]!.resolve(ok({ items, truncated: false }));
    await app.render();
    expect(app.menu().height).toBeGreaterThan(1);
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const filledGeometry = geometry(),
      filledFooter = footer();

    app.mockInput.pressKey("a");
    await app.render();
    expect(app.captureCharFrame()).toContain("abcdef-1.ts");
    expect(app.captureCharFrame()).toContain("Updating");
    expect(geometry()).toEqual(filledGeometry);
    expect(footer()).toBe(filledFooter);
    app.mockInput.pressTab();
    await app.render();
    expect(app.input.value).toBe("@a");
    expect(app.sent).toEqual([]);
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    app.clock.advance(150);
    await app.render();
    pending[1]!.resolve(ok({ items, truncated: false }));
    await app.render();
    expect(geometry()).toEqual(filledGeometry);
    expect(footer()).toBe(filledFooter);
    app.mockInput.pressTab();
    await app.render();
    expect(app.input.value).toBe("[File #1] ");
    expect(app.input.submission.text).toBe(
      `@${JSON.stringify(resolve(app.selection.worktree!.path, "abcdef-2.ts"))} `,
    );
  } finally {
    await app.close();
  }
});

test.each(["escape", "blur", "session", "dispose", "renderer"] as const)(
  "%s cancels debounce timers so delayed queries never start",
  async (action) => {
    let calls = 0;
    const app = await mount(async () => {
      calls++;
      return ok({ items: commandItems, truncated: false });
    });
    try {
      app.mockInput.pressKey("/");
      await app.render();
      expect(calls).toBe(0);
      if (action === "escape") app.mockInput.pressEscape();
      if (action === "blur") openWorkspaceSearch(app);
      if (action === "session") app.selection.selectSession("demo:feature", "b1");
      if (action === "dispose") app.view.dispose();
      if (action === "renderer") app.renderer.destroy();
      for (let index = 0; index < 8; index++) await Promise.resolve();
      app.clock.advance(1000);
      for (let index = 0; index < 8; index++) await Promise.resolve();
      expect(calls).toBe(0);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Loading completion never changes candidate columns or heights", async () => {
  // Fast lookup spinner tails neither delay candidates nor retain separate status rows.
  const app = await mount();
  try {
    await app.type("@");
    const position = () => [
      app.menu().height,
      app.captureCharFrame().split("\n")[app.menu().y]!.indexOf("src/main.ts"),
    ];
    const before = position();
    expect(before[1]).toBeGreaterThan(0);
    expect(app.menu().height).toBe(2);

    // After shared minimum duration, remove only indicators in place.
    app.clock.advance(500);
    await app.render();

    expect(position()).toEqual(before);
    expect(app.captureCharFrame()).toContain("src/main.ts");
  } finally {
    await app.close();
  }
});

test("Empty results and lookup errors preserve open-menu height and input position", async () => {
  let failure = false;
  const app = await mount(async () =>
    failure ? err(new CapabilityError("Lookup failed")) : ok({ items: [], truncated: false }),
  );
  try {
    app.mockInput.pressKey("/");
    await app.render();
    const geometry = [app.menu().height, app.input.y];
    app.clock.advance(150);
    await app.render();
    expect(app.captureCharFrame()).toContain("No matches");
    expect([app.menu().height, app.input.y]).toEqual(geometry);
    failure = true;
    app.mockInput.pressKey("a");
    await app.render();
    app.clock.advance(150);
    await app.render();
    expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY");
    expect([app.menu().height, app.input.y]).toEqual(geometry);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Slash suggests commands only at input start and non-email inline @ suggests files", async () => {
  // The real input and router stay active; only read-only discovery is replaced.
  const app = await mount();
  try {
    await app.type("text /mc");
    expect(app.menu().visible).toBe(false);
    app.input.value = "";
    await app.type("user@example.com");
    expect(app.menu().visible).toBe(false);
    app.input.value = "";
    await app.type("check @src/");
    expect(app.menu().visible).toBe(true);
    expect(app.captureCharFrame()).toContain("src/main.ts");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each(["command", "template", "skill"] as const)(
  "One Enter completes and immediately submits the selected %s candidate",
  async (kind) => {
    // The selected resource, not the incomplete token, is the intended command.
    const value = kind === "skill" ? "skill:compact-guide" : "compact";
    const app = await mount(async () =>
      ok({ items: [{ kind, value, description: "Selected resource" }], truncated: false }),
    );
    try {
      const trigger = kind === "skill" ? "$" : "/",
        name = value.replace(/^skill:/u, "");
      await app.type(`${trigger}com`);
      expect(app.captureCharFrame()).toContain(`→ ${name}`);

      app.mockInput.pressEnter();
      await app.render();

      expect(app.sent).toEqual([`${trigger}${kind === "skill" ? name : value}`]);
      expect(app.input.value).toBe("");
      expect(app.menu().visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    } finally {
      await app.close();
    }
  },
);

test("Enter executes current selections rather than first candidates and preserves trailing arguments", async () => {
  const app = await mount(async () =>
    ok({
      items: ["compact", "compare"].map((value) => ({
        kind: "command" as const,
        value,
        description: value,
      })),
      truncated: false,
    }),
  );
  try {
    app.input.value = "/com keep these instructions";
    app.input.cursorOffset = app.input.editBuffer.measureText("/com");
    await app.complete();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    app.mockInput.pressEnter();
    await app.render();

    expect(app.sent).toEqual(["/compare keep these instructions"]);
    expect(app.input.value).toBe("");
  } finally {
    await app.close();
  }
});

test("Enter during command refresh waits for latest results and submits the same selection once", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  const item = { kind: "command" as const, value: "compact", description: "Compact context" };
  const app = await mount(async (_id, query) =>
    query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }),
  );
  try {
    await app.type("/co");
    app.mockInput.pressKey("m");
    await app.complete();

    app.mockInput.pressEnter();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/com");
    pending.resolve(ok({ items: [item], truncated: false }));
    await app.render();

    expect(app.sent).toEqual(["/compact"]);
    expect(app.input.value).toBe("");
  } finally {
    pending.resolve(ok({ items: [item], truncated: false }));
    await app.close();
  }
});

test.each(["edit", "dismiss", "session", "blur", "dispose", "changed-selection"] as const)(
  "%s after Enter during command refresh prevents late execution",
  async (action) => {
    const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
    const item = { kind: "command" as const, value: "compact", description: "Compact context" };
    const app = await mount(async (_id, query) =>
      query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }),
    );
    try {
      await app.type("/co");
      app.mockInput.pressKey("m");
      await app.complete();
      app.mockInput.pressEnter();
      await app.render();

      if (action === "edit") app.mockInput.pressKey("x");
      if (action === "dismiss") app.mockInput.pressEscape();
      if (action === "session") app.selection.selectSession("demo:feature", "b1");
      if (action === "blur") openWorkspaceSearch(app);
      if (action === "dispose") app.view.dispose();
      pending.resolve(
        ok({
          items: action === "changed-selection" ? [{ ...item, value: "compare" }] : [item],
          truncated: false,
        }),
      );
      await app.render();

      expect(app.sent).toEqual([]);
      expect(app.view.promptDrafts.a1).toBe(action === "edit" ? "/comx" : "/com");
    } finally {
      pending.resolve(ok({ items: [item], truncated: false }));
      await app.close();
    }
  },
);

test.each(["empty", "error"] as const)(
  "Command refresh ending in %s never lets pending Enter submit incomplete commands",
  async (outcome) => {
    const pending = Promise.withResolvers<
      ReturnType<typeof ok<CompletionResult>> | ReturnType<typeof err<CapabilityError>>
    >();
    const item = { kind: "command" as const, value: "compact", description: "Compact context" };
    const app = await mount(async (_id, query) =>
      query.query === "com" ? pending.promise : ok({ items: [item], truncated: false }),
    );
    try {
      await app.type("/co");
      app.mockInput.pressKey("m");
      await app.complete();
      app.mockInput.pressEnter();
      await app.render();

      pending.resolve(
        outcome === "error"
          ? err(new CapabilityError("Lookup failed"))
          : ok({ items: [], truncated: false }),
      );
      await app.render();

      expect(app.sent).toEqual([]);
      expect(app.input.value).toBe("/com");
      expect(app.menu().visible).toBe(true);
      expect(app.captureCharFrame()).toContain(
        outcome === "error" ? "Lookup failed" : "No matches",
      );
    } finally {
      pending.resolve(ok({ items: [], truncated: false }));
      await app.close();
    }
  },
);

test("Rejected selections consume held Enter repeats without resending and retain completed drafts", async () => {
  const app = await mount(
    async () =>
      ok({
        items: [{ kind: "command", value: "compact", description: "Compact context" }],
        truncated: false,
      }),
    () => err(new InputError("Command rejected")),
  );
  const raw = (text: string) => {
    const key = parseKeypress(text, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key fixture");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.type("/com");

    raw("\u001b[13;1u");
    await app.render();
    raw("\u001b[13;1:2u");
    await app.render();
    raw("\u001b[13;1:3u");
    await app.render();

    expect(app.sent).toEqual(["/compact"]);
    expect(app.input.value).toBe("/compact");
    expect(app.captureCharFrame()).toContain("Command rejected");
  } finally {
    await app.close();
  }
});

test.each(["/", "$", "@"] as const)(
  "%s completion arrows move candidates instead of input carets",
  async (trigger) => {
    // All three candidate menus support default arrows while retaining input focus.
    const kind = trigger === "/" ? "command" : trigger === "$" ? "skill" : "file";
    const items: CompletionItem[] = ["candidate-a", "candidate-b", "candidate-c"].map((value) => ({
      kind,
      value,
      description: "Candidate",
    }));
    const app = await mount(async () => ok({ items, truncated: false }));
    try {
      await app.type(trigger);
      const cursor = app.input.cursorOffset;

      // Move down twice and up once to verify both arrow directions.
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("up");
      await app.render();

      expect(app.captureCharFrame()).toContain("→ candidate-b");
      expect(app.input.value).toBe(trigger);
      expect(app.input.cursorOffset).toBe(cursor);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.sent).toEqual([]);
      expect(app.captureCharFrame().split("\n")[app.renderer.height - 1]).not.toContain(
        "<C-n> Next",
      );
      app.mockInput.pressTab();
      await app.render();

      expect(app.input.value).toBe(trigger === "@" ? "[File #1] " : `${trigger}candidate-b `);
      expect(app.menu().visible).toBe(false);
      expect(app.sent).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test("Closing completion restores ordinary arrow editing and literal hjkl", async () => {
  // Dismissed multiline menus must stop consuming arrows as candidate navigation.
  const app = await mount();
  try {
    await app.mockInput.pasteBracketedText("first line\n@");
    await app.complete();
    expect(app.menu().visible).toBe(true);
    app.mockInput.pressEscape();
    await app.render();
    const cursor = app.input.cursorOffset;

    // After Esc, move the caret up in the same input and type literal Vim characters.
    app.mockInput.pressArrow("up");
    await app.render();
    expect(app.input.cursorOffset).toBeLessThan(cursor);
    await app.mockInput.typeText("hjkl");
    await app.render();

    expect(app.input.value).toContain("hjkl");
    expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Ctrl+N/P selects candidates, Tab only completes, and Enter immediately submits selected commands", async () => {
  const app = await mount();
  try {
    await app.type("/");
    expect(app.captureCharFrame()).not.toContain("<C-n> Next");
    expect(app.captureCharFrame()).toContain("<Tab> Insert");
    expect(app.captureCharFrame()).not.toContain("<CR> Queue");
    expect(app.captureCharFrame()).not.toContain("<Tab>/<CR>");
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    app.mockInput.pressKey("p", { ctrl: true });
    await app.render();
    app.mockInput.pressTab();
    await app.render();

    expect(app.input.value).toBe("/mcp ");
    expect(app.menu().visible).toBe(false);
    expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressEnter();
    await app.render();
    expect(app.sent).toEqual(["/mcp "]);

    // A fully typed command must not need a second Enter or acquire a completion's trailing space.
    await app.type("/memory");
    expect(app.menu().visible).toBe(true);
    app.mockInput.pressEnter();
    await app.render();
    expect(app.input.value).toBe("");
    expect(app.sent).toEqual(["/mcp ", "/memory"]);
    expect(app.menu().visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Held kitty Tab repeats never become focus traversal after insertion", async () => {
  const app = await mount();
  const raw = (text: string) => {
    const key = parseKeypress(text, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key fixture");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    await app.type("/");
    raw("\u001b[9;1u");
    raw("\u001b[9;1:2u");
    await app.render();
    expect(app.input.value).toBe("/mcp ");
    expect(app.sent).toEqual([]);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    raw("\u001b[9;1:3u");
    app.mockInput.pressEnter();
    await app.render();
    expect(app.sent).toEqual(["/mcp "]);
  } finally {
    await app.close();
  }
});

test("Repeated kitty Enter never duplicates selected command submissions", async () => {
  const app = await mount();
  const raw = (text: string) => {
    const key = parseKeypress(text, { useKittyKeyboard: true });
    if (!key) throw new Error("Invalid key fixture");
    app.renderer.keyInput.processParsedKey(key);
  };
  try {
    // Key repeat can arrive before admission or after the accepted draft has been cleared.
    await app.type("/mcp");
    raw("\u001b[13;1u");
    raw("\u001b[13;1:2u");
    await app.render();
    raw("\u001b[13;1:2u");
    raw("\u001b[13;1:3u");
    await app.render();

    expect(app.sent).toEqual(["/mcp"]);
    expect(app.input.value).toBe("");
    expect(app.renderer.currentFocusedRenderable?.id).toBe(app.input.id);
  } finally {
    await app.close();
  }
});

test.each([
  ["/mc", "/mcp"],
  ["@src/", "@src/"],
])(
  "Enter completes only %s command candidates and never auto-inserts file candidates",
  async (draft, submitted) => {
    const app = await mount();
    try {
      // Command execution uses the focused slash resource; file attachment remains a Tab action.
      await app.type(draft);
      app.mockInput.pressKey("n", { ctrl: true });
      await app.render();
      expect(app.menu().visible).toBe(true);
      app.mockInput.pressEnter();
      await app.render();

      expect(app.sent).toEqual([submitted]);
      expect(app.input.value).toBe("");
      expect(app.menu().visible).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("Triggers and Enter in one input batch immediately submit actual input, not candidates", async () => {
  const app = await mount();
  try {
    // Submission is independent of the completion debounce and its queued render.
    app.mockInput.pressKey("/");
    app.mockInput.pressEnter();
    await app.render();

    expect(app.sent).toEqual(["/"]);
    expect(app.input.value).toBe("");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.menu().visible).toBe(false);
  } finally {
    await app.close();
  }
});

test.each(["/", "@"])(
  "Trigger %s and Tab in one input batch neither submit nor move focus",
  async (trigger) => {
    const app = await mount();
    try {
      // Tab waits for fresh candidates instead of sending a partially typed command or reference.
      app.mockInput.pressKey(trigger);
      app.mockInput.pressTab();
      await app.render();

      expect(app.sent).toEqual([]);
      expect(app.input.value).toBe(trigger);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      expect(app.menu().visible).toBe(true);
      app.mockInput.pressEscape();
      await app.render();
      expect(app.menu().visible).toBe(false);
      expect(app.input.value).toBe(trigger);
    } finally {
      await app.close();
    }
  },
);

test.each(["pending", "empty", "error"] as const)(
  "Enter submits typed commands once even when lookup is %s",
  async (state) => {
    const pending = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
    const app = await mount(async () =>
      state === "pending"
        ? pending.promise
        : state === "error"
          ? err(new CapabilityError("Lookup unavailable"))
          : ok({ items: [], truncated: false }),
    );
    try {
      // Read-only discovery must not gate execution, even when it fails or has no matches.
      await app.type("/mcp");
      expect(app.menu().visible).toBe(true);
      if (state === "empty") expect(app.captureCharFrame()).toContain("No matches");
      if (state === "error") expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY");
      app.mockInput.pressEnter();
      app.mockInput.pressEnter();
      await app.render();

      expect(app.sent).toEqual(["/mcp"]);
      expect(app.input.value).toBe("");
      expect(app.menu().visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    } finally {
      pending.resolve(ok({ items: commandItems, truncated: false }));
      await app.close();
    }
  },
);

test("Esc closes only candidates while hjkl stays literal and existing drafts remain unsubmitted", async () => {
  const app = await mount();
  try {
    await app.type("/");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.input.value).toBe("/");
    expect(app.menu().visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);

    await app.type("hjkl");
    expect(app.input.value).toBe("/hjkl");
    expect(app.view.promptDrafts.a1).toBe("/hjkl");
    expect(app.sent).toEqual([]);
    app.mockInput.pressEscape();
    await app.render();
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    await app.close();
  }
});

test("Completion inside tokens after Korean/emoji replaces full paths while preserving trailing requests and native caret", async () => {
  const app = await mount();
  try {
    const text = "한글 👩‍💻 @src/old.ts 뒤의 요청";
    // Bracketed paste sends intact Unicode; the test helper's typeText splits UTF-16 surrogate pairs.
    await app.mockInput.pasteBracketedText(text);
    await app.render();
    expect(app.input.value).toBe(text);
    app.input.cursorOffset = app.input.editBuffer.measureText(text.slice(0, text.indexOf("old")));
    await app.complete();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    app.mockInput.pressTab();
    await app.render();

    const prefix = "한글 👩‍💻 [File #1]";
    expect(app.input.value).toBe(prefix + " 뒤의 요청");
    expect(app.input.cursorOffset).toBe(app.input.editBuffer.measureText(prefix));
    expect(app.view.promptDrafts.a1).toBe(
      `한글 👩‍💻 @${JSON.stringify(resolve(app.selection.worktree!.path, "src/문서 file.ts"))} 뒤의 요청`,
    );
    expect(app.input.draft.tokens).toHaveLength(1);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Tab during lookup never submits, failures stay explicit, and drafts/focus persist", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof err<CapabilityError>>>();
  const app = await mount(async () => pending.promise);
  try {
    await app.type("/");
    app.mockInput.pressTab();
    await app.render();
    expect(app.sent).toEqual([]);
    expect(app.input.value).toBe("/");
    pending.resolve(err(new CapabilityError("Service needs an explicit upgrade")));
    await app.render();
    expect(app.captureCharFrame()).toContain("UNSUPPORTED_CAPABILITY");
    expect(app.menu().visible).toBe(true);
    expect(app.input.value).toBe("/");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressEscape();
    await app.render();
    expect(app.menu().visible).toBe(false);
  } finally {
    await app.close();
  }
});

test("Stale candidates after session switching are ignored while each draft survives", async () => {
  const pending: {
    id: string;
    signal: AbortSignal;
    gate: ReturnType<typeof Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>>;
  }[] = [];
  const app = await mount(async (id, _query, signal) => {
    const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
    pending.push({ id, signal, gate });
    return gate.promise;
  });
  try {
    await app.type("/");
    const other = app.selection.snapshot
      .flatMap((repo) => repo.worktrees)
      .flatMap((tree) => tree.sessions.map((session) => ({ tree, session })))
      .find(({ session }) => session.id !== "a1")!;
    app.selection.selectSession(other.tree.id, other.session.id);
    await app.render();
    await app.type("@");
    expect(pending[0]?.signal.aborted).toBe(true);
    pending.at(-1)!.gate.resolve(ok({ items: fileItems, truncated: false }));
    await app.render();
    pending[0]!.gate.resolve(
      ok({
        items: [{ kind: "command", value: "stale-command", description: "" }],
        truncated: false,
      }),
    );
    await app.render();

    expect(app.captureCharFrame()).toContain("src/main.ts");
    expect(app.captureCharFrame()).not.toContain("stale-command");
    expect(app.view.promptDrafts.a1).toBe("/");
    expect(app.view.promptDrafts[other.session.id]).toBe("@");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Renderer-first shutdown cancels lookups and late responses never access native buffers", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof ok<CompletionResult>>>();
  let signal: AbortSignal | undefined;
  const app = await mount(async (_id, _query, abort) => {
    signal = abort;
    return gate.promise;
  });
  try {
    await app.type("/");
    app.renderer.destroy();
    gate.resolve(ok({ items: commandItems, truncated: false }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(app.sent).toEqual([]);
    app.view.dispose();
  } finally {
    await app.close();
  }
});

test("Streaming and compact layouts retain selection with candidates between input and footer", async () => {
  let queries = 0;
  const app = await mount(async (_id, query) => {
    queries++;
    return ok(filterCompletions(commandItems, query.query));
  });
  try {
    await app.type("/");
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    const before = queries;
    await app.stream("Streaming more output");
    app.resize(60, 12);
    await app.render();
    const composer = app.renderer.root.findDescendantById("agent-composer")!;
    const footer = app.renderer.root.findDescendantById("footer-bar")!;
    expect(app.menu().y).toBeGreaterThanOrEqual(composer.y + composer.height);
    expect(app.menu().y + app.menu().height).toBeLessThanOrEqual(footer.y);
    expect(queries).toBe(before);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    app.mockInput.pressTab();
    await app.render();
    expect(app.input.value).toBe("/memory ");
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});
