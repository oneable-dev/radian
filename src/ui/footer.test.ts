import { expect, spyOn, test } from "bun:test";
import {
  BoxRenderable,
  InputRenderable,
  type TerminalColors,
  type TextRenderable,
} from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { ProviderUsage } from "../usage/model.ts";
import { Footer } from "./footer.ts";
import { uiTheme } from "./theme.ts";
import { icons } from "../icons.ts";

const usage = (provider: string, usedPercent: number, resetsAt: number): ProviderUsage => ({
  provider,
  status: "ready",
  windows: [{ id: "weekly", usedPercent, periodMs: 604800000, resetsAt }],
  updatedAt: 0,
  errorCode: null,
});

async function mount(width = 100, height = 8) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width, height, kittyKeyboard: true, clock });
  const screen = new BoxRenderable(app.renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  const body = new BoxRenderable(app.renderer, { flexGrow: 1, minHeight: 0 });
  const input = new InputRenderable(app.renderer, { width: "100%", value: "draft" });
  const footer = new Footer(app.renderer);

  body.add(input);
  screen.add(body);
  screen.add(footer.root);
  app.renderer.root.add(screen);
  input.focus();
  await app.renderOnce();

  return {
    ...app,
    footer,
    clock,
    body,
    input,
    line: () => app.captureCharFrame().split("\n")[footer.bar.y]!,
  };
}

test("View blocks replace branding without reserving a second footer row", async () => {
  // Passive identity must stay readable without reducing the input's height.
  const app = await mount(120, 24);
  try {
    app.footer.setView("TERMINAL");
    app.footer.setContext("Extension status");
    await app.renderOnce();

    expect(app.line().trimStart()).toStartWith("TERMINAL");
    expect(app.line()).not.toContain("Radian");
    expect(app.line()).toContain("Extension status");
    expect(app.line()).not.toMatch(/<CR>|<leader>|Help/u);
    expect(app.footer.root.height).toBe(1);
    expect(app.body.height).toBe(23);
    expect(app.renderer.root.findDescendantById("footer-notice-row")).toBeUndefined();
    for (const width of [60, 30, 12, 120]) {
      app.resize(width, 12);
      await app.renderOnce();
      expect(app.line()).toContain("TERMINAL");
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
      expect(app.footer.bar.y).toBe(11);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    }
  } finally {
    await app.dispose();
  }
});

test("Workspace context uses existing icons and a middle dot without separate backgrounds", async () => {
  // Scope belongs to the selected worktree, independently of the active screen.
  const app = await mount(120);
  try {
    app.footer.setWorkspace({ name: "auth-checkout", branch: "feature/auth" });
    await app.renderOnce();

    expect(app.line().trimStart()).toStartWith(
      `AGENT  ${icons.folder} auth-checkout · ${icons.branch} feature/auth`,
    );

    const identity = app.renderer.root.findDescendantById("footer-identity")!;
    const workspace = app.renderer.root.findDescendantById("footer-workspace")!;
    const styles = uiTheme(app.renderer).styles;

    expect(styles["footer.worktree"].bg).toBeUndefined();
    expect(styles["footer.branch"].bg).toBeUndefined();

    let column = 0;
    for (const span of app.captureSpans().lines[workspace.y]!.spans) {
      const end = column + span.width;
      if (column < workspace.x + workspace.width && end > workspace.x) {
        expect(span.bg.toInts()).toEqual(styles["footer.identity"].bg!.toInts());
      }

      column = end;
    }

    expect(workspace.x).toBe(identity.x + identity.width);
    expect(app.renderer.root.findDescendantById("footer-hints")).toBeUndefined();
    expect(app.renderer.root.findDescendantById("footer-help")).toBeUndefined();
    for (const view of ["AGENT", "EDITOR", "GIT", "TERMINAL"]) {
      app.footer.setView(view);
      await app.renderOnce();
      expect(app.line()).toContain(view);
      expect(app.line()).toContain("auth-checkout");
      expect(app.line()).toContain("feature/auth");
      expect(workspace.x).toBe(identity.x + identity.width);
    }

    app.footer.setWorkspace({ name: "auth-checkout", branch: null });
    await app.renderOnce();
    expect(app.line()).toContain("detached HEAD");
  } finally {
    await app.dispose();
  }
});

test("View labels keep exactly one space on both sides at every width", async () => {
  // The screen badge must stay symmetric instead of inheriting the work pane's responsive inset.
  const app = await mount();
  try {
    for (const width of [120, 80, 60, 120]) {
      app.resize(width, 8);
      for (const view of [
        "AGENT",
        "EDITOR",
        "GIT",
        "TERMINAL",
        "USAGE",
        "NORMAL",
        "VISUAL",
        "VISUAL LINE",
        "HELP",
      ]) {
        app.footer.setView(view);
        await app.renderOnce();

        const identity = app.renderer.root.findDescendantById("footer-identity") as TextRenderable;
        expect(identity.plainText).toBe(` ${view} `);
        expect(identity.width).toBe(view.length + 2);
      }
    }

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("draft");
  } finally {
    await app.dispose();
  }
});

test("Narrow Unicode workspaces truncate safely and restore after resize", async () => {
  // A wide checkout name must never push the active view outside the footer.
  const app = await mount(120);
  try {
    app.footer.setView("TERMINAL");
    app.footer.setWorkspace({ name: "작업공간".repeat(10), branch: "feature/".repeat(10) });
    for (const width of [120, 40, 20, 8, 120]) {
      app.resize(width, 8);
      await app.renderOnce();
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
      expect(app.footer.root.height).toBe(1);
      expect(app.input.value).toBe("draft");
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
      if (width >= 20) {
        expect(app.line()).toContain("TERMINAL");
      }
      if (width >= 40) {
        expect(app.line()).toContain("…");
      }
    }
  } finally {
    await app.dispose();
  }
});

test("Footer mode background is uniform and follows terminal palettes", async () => {
  // Theme changes must recolor the block, not recreate the old per-cell gradient.
  const app = await mount();
  const palette = (light: boolean): TerminalColors => ({
    palette: [
      "#000000",
      "#CC2222",
      "#228822",
      "#998800",
      "#2255AA",
      "#AA22AA",
      light ? "#996633" : "#117799",
      "#DDDDDD",
    ],
    defaultForeground: light ? "#202020" : "#ECECEC",
    defaultBackground: light ? "#FAFAF6" : "#141414",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightForeground: null,
    highlightBackground: null,
  });
  try {
    for (const light of [false, true]) {
      app.renderer.emit("palette", palette(light));
      await app.renderOnce();

      const identity = app.renderer.root.findDescendantById("footer-identity")!;
      const styles = uiTheme(app.renderer).styles;

      expect(styles["footer.mode"].fg.intent).toBe("rgb");

      let x = 0;
      for (const span of app.captureSpans().lines[app.footer.bar.y]!.spans) {
        if (x < identity.width) {
          expect(span.bg.toInts()).toEqual(styles["footer.mode"].bg!.toInts());
        }

        x += span.width;
      }

      expect(identity.x).toBe(0);
      expect(app.line().indexOf("AGENT")).toBe(1);
    }
  } finally {
    await app.dispose();
  }
});

test("Provider usage replaces shortcut hints and stays right-aligned independently of input focus", async () => {
  // Each connected account has its own quota; duplicate catalog entries must not repeat its provider.
  const app = await mount(160);
  const now = Date.now();
  try {
    app.footer.setUsage(
      {
        "openai-codex": usage("openai-codex", 18, now + 3600000),
        anthropic: usage("anthropic", 43, now + 7200000),
      },
      ["openai-codex", "anthropic", "anthropic", "custom"],
    );
    await app.renderOnce();

    // Account metrics occupy the global row, never keyboard instructions or session context.
    expect(app.line()).toContain("18% used 1h 0m");
    expect(app.line()).toContain("43% used 2h 0m");
    expect(app.line()).toContain(icons.openai);
    expect(app.line()).toContain(icons.claude);
    expect(app.line()).toContain(`${icons.robot} -`);
    expect(app.line().split(icons.claude)).toHaveLength(2);
    expect(app.line()).not.toMatch(/<CR>|<leader>|Help|left/u);
    expect(app.line().trimEnd()).toEndWith(`${icons.robot} -`);
    expect(app.renderer.root.findDescendantById("footer-provider-icon-anthropic")?.y).toBe(
      app.footer.bar.y,
    );
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("draft");
  } finally {
    await app.dispose();
  }
});

test("Narrow footers drop reset times before provider percentages and restore after resizing", async () => {
  // Multiple connections must remain identifiable without making the footer taller.
  const app = await mount(160);
  try {
    app.footer.setUsage(
      {
        openai: usage("openai", 18, Date.now() + 3600000),
        anthropic: usage("anthropic", 43, Date.now() + 7200000),
      },
      ["openai", "anthropic"],
    );

    // Compact rendering keeps both ratios; extremely small screens summarize overflow.
    app.resize(40, 8);
    await app.renderOnce();
    expect(app.line()).toContain("18%");
    expect(app.line()).toContain("43%");
    expect(app.line()).not.toContain("1h 0m");
    for (const width of [24, 12, 8, 160]) {
      app.resize(width, 8);
      await app.renderOnce();
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
      expect(app.footer.root.height).toBe(1);
      expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    }
    expect(app.line()).toContain("18% used 1h 0m");
    expect(app.line()).toContain("43% used 2h 0m");
    expect(app.input.value).toBe("draft");
  } finally {
    await app.dispose();
  }
});

test("Recovering providers keep muted bars and independent loading indicators without stale values", async () => {
  // A failed refresh retains its account's prior quota but must not present it as current data.
  const app = await mount(160);
  const previous = usage("openai", 18, Date.now() + 3600000);
  const healthy = usage("anthropic", 43, Date.now() + 7200000);
  try {
    app.footer.setUsage(
      {
        openai: { ...previous, status: "error", errorCode: "USAGE_QUERY_FAILED" },
        anthropic: healthy,
      },
      ["openai", "anthropic"],
    );
    await app.renderOnce();
    const spinner = app.renderer.root.findDescendantById("footer-usage-loading-openai")!;

    // Recovery only suppresses the affected provider's percentage and countdown.
    expect(spinner.visible).toBe(true);
    expect(app.line()).not.toContain("18% used");
    expect(app.line()).not.toContain("1h 0m");
    expect(app.line()).toContain("43% used");
    expect(app.line()).toContain("▉");

    // New values appear immediately while the shared spinner finishes its minimum-visible tail.
    app.footer.setUsage(
      {
        openai: { ...previous, windows: [{ ...previous.windows[0]!, usedPercent: 22 }] },
        anthropic: healthy,
      },
      ["openai", "anthropic"],
    );
    await app.renderOnce();
    expect(app.line()).toContain("22% used");
    expect(spinner.visible).toBe(true);
    app.clock.advance(500);
    await app.renderOnce();
    expect(spinner.visible).toBe(false);
    expect(app.line()).toContain("22% used");
  } finally {
    await app.dispose();
  }
});

test("A new quota recovery restarts the spinner minimum interval during an earlier completion tail", async () => {
  // Success can be followed by another account refresh before the first spinner finishes hiding.
  const app = await mount(120);
  const ready = usage("openai", 18, Date.now() + 3600000);
  const loading: ProviderUsage = { ...ready, status: "loading" };
  try {
    app.footer.setUsage({ openai: loading }, ["openai"]);
    await app.renderOnce();
    app.footer.setUsage({ openai: ready }, ["openai"]);
    app.clock.advance(400);

    // The second operation owns a fresh minimum interval, not the first operation's pending hide.
    app.footer.setUsage({ openai: loading }, ["openai"]);
    app.clock.advance(100);
    await app.renderOnce();
    const spinner = app.renderer.root.findDescendantById("footer-usage-loading-openai")!;
    expect(spinner.visible).toBe(true);
    app.footer.setUsage({ openai: ready }, ["openai"]);
    app.clock.advance(399);
    await app.renderOnce();
    expect(spinner.visible).toBe(true);
    expect(app.line()).toContain("18% used");
    app.clock.advance(1);
    await app.renderOnce();
    expect(spinner.visible).toBe(false);
  } finally {
    await app.dispose();
  }
});

test("Footer reset countdowns use the longest live window and expire without new snapshots", async () => {
  // Provider timestamps can change while the runtime has no other events to publish.
  let now = 1800000000000;
  const time = spyOn(Date, "now").mockImplementation(() => now);
  const app = await mount(160);
  try {
    const weekly = usage("openai", 18, now + 120000);
    app.footer.setUsage(
      {
        openai: {
          ...weekly,
          windows: [
            { id: "short", usedPercent: 90, periodMs: 60000, resetsAt: now + 60000 },
            ...weekly.windows,
          ],
        },
      },
      ["openai"],
    );
    await app.renderOnce();
    expect(app.line()).toContain("18% used 2m");
    expect(app.line()).not.toContain("90%");

    // A minute tick updates the countdown; expiry clears observed quota rather than showing zero usage.
    now += 60000;
    app.clock.advance(60000);
    await app.renderOnce();
    expect(app.line()).toContain("18% used 1m");
    now += 60000;
    app.clock.advance(60000);
    await app.renderOnce();
    expect(app.line()).not.toContain("18%");
    expect(app.line()).not.toContain("0% used");
    expect(app.line()).toContain(icons.openai);
  } finally {
    time.mockRestore();
    await app.dispose();
  }
});

test("Removing connections destroys their icons and cancels loading timers", async () => {
  // Authentication changes must not leave quota images or background animations attached.
  const app = await mount(120);
  try {
    app.footer.setUsage(
      { openai: { ...usage("openai", 18, Date.now() + 60000), status: "loading" } },
      ["openai"],
    );
    await app.renderOnce();
    expect(app.renderer.root.findDescendantById("footer-usage-loading-openai")?.visible).toBe(true);

    app.footer.setUsage({}, []);
    await app.renderOnce();
    app.clock.advance(60000);
    await app.renderOnce();

    expect(app.renderer.root.findDescendantById("footer-provider-icon-openai")).toBeUndefined();
    expect(app.renderer.root.findDescendantById("footer-usage-loading-openai")).toBeUndefined();
    expect(app.line()).not.toContain(icons.openai);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    await app.dispose();
  }
});

test("Unchanged footer frames settle without scheduling an idle render loop", async () => {
  // A passive footer without polling or animation should not keep the renderer awake.
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 120, height: 4, clock });
  const footer = new Footer(app.renderer);
  app.renderer.root.add(footer.root);
  footer.setUsage(
    {
      openai: {
        ...usage("openai", 18, 0),
        windows: [{ id: "quota", usedPercent: 18, periodMs: null, resetsAt: null }],
      },
    },
    ["openai"],
  );
  try {
    // Advance scheduled paints until initial layout has settled, without supplying fresh data.
    for (let pass = 0; pass < 5; pass++) {
      clock.advance(20);
      await app.renderOnce();
    }

    expect(app.captureCharFrame()).toContain("18% used");
    expect(app.renderer.getSchedulerState().hasScheduledRender).toBe(false);
  } finally {
    await app.dispose();
  }
});

test("Passive footer clicks and height changes preserve drafts and focus", async () => {
  // Clicking passive account metadata must not take ownership of the active editor.
  const app = await mount();
  try {
    await app.mockMouse.click(2, app.footer.bar.y);
    app.resize(100, 24);
    await app.renderOnce();

    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
    expect(app.input.value).toBe("draft");
    expect(app.body.y + app.body.height).toBe(app.footer.bar.y);
    expect(app.footer.root.height).toBe(1);

    const before = app.renderer.listenerCount("resize");
    app.footer.root.destroyRecursively();
    expect(app.renderer.listenerCount("resize")).toBe(before - 1);

    // Late account snapshots cannot recreate icons or timers after the owning surface closes.
    expect(() =>
      app.footer.setUsage({ openai: usage("openai", 18, Date.now() + 60000) }, ["openai"]),
    ).not.toThrow();
    expect(() => app.clock.advance(60000)).not.toThrow();
  } finally {
    await app.dispose();
  }
});
