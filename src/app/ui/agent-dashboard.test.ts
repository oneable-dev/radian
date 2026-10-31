import { expect, spyOn, test } from "bun:test";
import * as os from "node:os";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import {
  emptyDashboard,
  type DashboardPeriod,
  type DashboardSnapshot,
} from "../../agents/dashboard.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import { CapabilityError, SessionError } from "../../errors.ts";
import type { ProcessResourceSample } from "../../usage/process-resources.ts";
import type { WorkspaceResourceSample } from "../../usage/workspace-resources.ts";
import { err, ok, type Result } from "../../result.ts";
import { parseKeymap } from "../../keybindings/config.ts";
import { expectOk } from "../../testing/results.ts";
import { demoWorkspace } from "../../workspace/demo.ts";
import { WorkspaceSelection } from "../workspace-selection.ts";
import { Workbench, type WorkbenchActions } from "./workbench.ts";

function sample(days: DashboardPeriod = 7): DashboardSnapshot {
  const data = emptyDashboard(days);
  data.totals = { tokens: 1240, runs: 9, durationMs: 65000 };
  Object.assign(data.daily.at(-1)!, data.totals);
  data.skills = [
    { name: "write-good-code", value: 42 },
    { name: "review-code", value: 18 },
  ];
  data.models = [{ name: "test/large", value: 1240 }];
  data.mcp = [{ name: "figma-remote", value: 12 }];
  data.subagents = [{ name: "reviewer", value: 3 }];

  return data;
}

async function mount(options: Partial<WorkbenchActions> = {}, width = 120, height = 32) {
  const clock = new ManualClock();
  const app = await createTestRenderer({ width, height, kittyKeyboard: true, clock });
  const lookups: {
    days: DashboardPeriod;
    project: string | undefined;
    signal: AbortSignal | undefined;
  }[] = [];
  const sent: string[] = [];
  const view = new Workbench(app.renderer, new WorkspaceSelection(demoWorkspace()), {
    onNewSession() {},
    onCloseSession() {},
    getSessionDetails: () => ({
      conversationId: "conversation",
      status: "complete",
      output: "Answer",
      error: null,
    }),
    onPrompt: (_id, text) => {
      sent.push(text);

      return ok(undefined);
    },
    onResources: async () =>
      ok({ pid: process.pid + 1, elapsedMs: 1000, cpuMicros: 0, rssBytes: 320 * 1024 ** 2 }),
    onDashboard: async (days, project, signal) => {
      lookups.push({ days, project, signal });

      return ok(sample(days));
    },
    ...options,
  });
  const render = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    await app.renderOnce();
    await app.renderOnce();
  };

  await render();

  const input = app.renderer.root.findDescendantById("session-prompt");
  if (!(input instanceof PromptInput)) {
    throw new Error("Missing prompt");
  }

  input.focus();

  const get = (id: string) => {
    const node = app.renderer.root.findDescendantById(id);
    if (!node) {
      throw new Error(`Missing ${id}`);
    }

    return node;
  };

  return {
    ...app,
    clock,
    view,
    input,
    lookups,
    sent,
    render,
    get,
    async open() {
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey("u");
      await render();
    },
    async close() {
      view.dispose();
      await app.dispose();
    },
  };
}

test("Dashboard commands open without prompting and preserve invalid arguments and attachments", async () => {
  // Distinguish commands from ordinary submission despite shared input routing.
  const app = await mount();
  try {
    app.input.value = "/dashboard";
    await app.render();

    // Explicit commands consume input and request only statistics.
    app.mockInput.pressEnter();
    await app.render();
    expect(app.get("agent-dashboard").visible).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.sent).toEqual([]);
    app.mockInput.pressEscape();
    await app.render();
    app.input.value = "/dashboard recent";
    await app.render();
    app.mockInput.pressEnter();
    await app.render();

    // Invalid arguments neither reach the model nor disappear silently.
    expect(app.input.value).toBe("/dashboard recent");
    expect(app.get("agent-dashboard").visible).toBe(false);
    expect(app.sent).toEqual([]);
    app.input.value = "/dashboard ";
    app.input.attachFile("/tmp/dashboard-fixture.png");

    const draft = app.input.draft;
    await app.render();
    app.mockInput.pressEnter();
    await app.render();
    expect(app.input.draft).toEqual(draft);
    expect(app.get("agent-dashboard").visible).toBe(false);
    expect(app.lookups).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Usage fills the work area at every size while the shared footer stays visible", async () => {
  // Usage has the same work-area boundary as Agent, not a centered popup size.
  const app = await mount();
  try {
    await app.open();

    for (const [width, height] of [
      [120, 32],
      [50, 18],
      [200, 60],
      [120, 32],
    ] as const) {
      // Resizing must not restore popup gutters or cover the persistent status line.
      app.resize(width, height);
      await app.render();

      const usage = app.get("agent-dashboard");
      const body = app.get("dashboard-body");
      const work = app.get("work-panel");
      const footer = app.get("app-footer");

      // The content starts at the top and reaches the footer without a surrounding frame.
      expect(usage.x).toBe(work.x);
      expect(usage.y).toBe(work.y);
      expect(usage.width).toBe(work.width);
      expect(usage.y + usage.height).toBe(footer.y);
      expect(body.y).toBe(work.y);
      expect(body.y + body.height).toBe(footer.y);
      expect(app.captureCharFrame().split("\n")[footer.y]?.trimStart()).toStartWith("USAGE");
      expect(app.get("agent-view").visible).toBe(false);
      expect(app.renderer.currentFocusedRenderable).toBe(body);
    }

    expect(app.lookups).toHaveLength(1);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([
  ["a", "AGENT", "agent"],
  ["e", "EDITOR", "editor"],
  ["g", "GIT", "git"],
  ["t", "TERMINAL", "terminal"],
] as const)(
  "Usage switches directly to %s without changing Agent drafts",
  async (key, label, view) => {
    // A full-screen usage view must not trap the global work-view commands.
    const app = await mount();
    try {
      app.input.value = "Retained draft";
      await app.open();

      // Select a work view without dismissing Usage first.
      app.mockInput.pressKey(" ", { ctrl: true });
      app.mockInput.pressKey(key);
      await app.render();

      // Screen changes stop sampling and leave the conversation untouched.
      expect(app.get("agent-dashboard").visible).toBe(false);
      expect(app.captureCharFrame().split("\n")[app.get("app-footer").y]?.trimStart()).toStartWith(
        label,
      );
      expect(app.view.workViewPreferences.active["demo:main"]).toBe(view);
      expect(app.input.value).toBe("Retained draft");
      expect(app.sent).toEqual([]);
      app.clock.advance(5000);
      await app.render();
      expect(app.get("dashboard-resources-loading").visible).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("Help opens over full-screen Usage and restores its focused filter on dismissal", async () => {
  // Usage owns the work area while ordinary popups remain available above it.
  const app = await mount();
  try {
    await app.open();
    const period = app.get("dashboard-period");
    period.focus();

    // Help uses the actual keymap rather than changing the selected Usage filter.
    app.mockInput.pressKey("F1");
    await app.render();

    expect(app.get("text-dialog").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("text-dialog-scroll");
    expect((app.get("text-dialog-body") as TextRenderable).plainText).toContain(
      "Return from usage",
    );

    // Esc closes Help first and returns keyboard ownership to the same Usage section.
    app.mockInput.pressEscape();
    await app.render();
    expect(app.get("text-dialog").visible).toBe(false);
    expect(app.get("agent-dashboard").visible).toBe(true);
    expect(app.renderer.currentFocusedRenderable).toBe(period);
  } finally {
    await app.close();
  }
});

test("Usage keeps coverage warnings and measurement prose in command-opened details instead of the main screen", async () => {
  // Partial historical coverage remains inspectable without dominating everyday statistics.
  const app = await mount({
    onDashboard: async () =>
      ok({ ...sample(), warnings: ["Fixture sessions lack settled run metadata."] }),
  });
  try {
    await app.open();
    app.get("dashboard-body").focus();
    app.mockInput.pressKey("END");
    await app.render();

    // The complete main surface stays free of persistent disclaimers, including its last row.
    expect(app.captureCharFrame()).not.toContain("Partial data");
    expect(app.captureCharFrame()).not.toContain("Tokens include");
    expect(app.captureCharFrame()).not.toContain("Coverage warnings");
    expect(app.get("dashboard-message").visible).toBe(false);
    expect(app.renderer.root.findDescendantById("dashboard-notes")).toBeUndefined();

    // Details is a configured command that preserves the selected filter and the Agent draft.
    const period = app.get("dashboard-period");
    period.focus();
    app.mockInput.pressKey("i");
    await app.render();
    const details = app.get("text-dialog-body") as TextRenderable;
    expect(details.plainText).toContain("Fixture sessions lack settled run metadata.");
    expect(details.plainText).toContain("Workspace processes include");
    expect(details.plainText).toContain("all logical CPUs together are 100%");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(period);
    expect(app.get("agent-dashboard").visible).toBe(true);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
  }
});

test("Workspace CPU and RAM stay readable across resize without changing filters or double-counting shared memory", async () => {
  // Independent process counters make the per-workspace shares deterministic.
  const cpus = spyOn(os, "cpus").mockReturnValue(
    Array.from({ length: 8 }, () => ({
      model: "Test",
      speed: 1000,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    })),
  );
  let elapsedMs = 1000;
  let scans = 0;
  const app = await mount({
    onWorkspaceResources: async () => {
      scans++;
      return ok([
        {
          id: "main",
          name: "Project / main",
          elapsedMs,
          processes: [
            {
              pid: 101,
              started: "original",
              cpuMicros: (elapsedMs - 1000) * 2000,
              rssBytes: 64 * 1024 ** 2,
            },
          ],
        },
        {
          id: "feature",
          name: "Unicode 작업 / feature",
          elapsedMs,
          processes: [
            {
              pid: 201,
              started: "original",
              cpuMicros: (elapsedMs - 1000) * 1000,
              rssBytes: 128 * 1024 ** 2,
            },
          ],
        },
      ]);
    },
  });
  try {
    await app.open();
    const table = app.get("dashboard-workspace-resources") as TextRenderable;
    expect(table.plainText).toContain("Project / main");
    expect(table.plainText).toContain("Unicode 작업 / feature");
    expect(table.plainText).toContain("64 MB");
    expect(table.plainText).toContain("128 MB");
    app.get("dashboard-period").focus();
    const body = app.get("dashboard-body") as ScrollBoxRenderable;
    const scrollTop = body.scrollTop;

    // Live samples do not change the history period, the body position or keyboard ownership.
    elapsedMs = 2000;
    app.clock.advance(1000);
    await app.render();
    expect(table.plainText).toMatch(/Project \/ main\s+25\.0%\s+64 MB/);
    expect(table.plainText).toMatch(/Unicode 작업 \/ feature\s+12\.5%\s+128 MB/);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-period");
    expect(body.scrollTop).toBe(scrollTop);

    // Narrow screens truncate names, never the CPU and RAM columns or process rows.
    app.resize(50, 18);
    await app.render();
    expect(table.plainText).toContain("25.0%");
    expect(table.plainText).toContain("128 MB");
    expect(table.plainText.split("\n").every((line) => Bun.stringWidth(line) <= table.width)).toBe(
      true,
    );
    app.mockInput.pressEscape();
    await app.render();
    app.clock.advance(5000);
    await app.render();
    expect(scans).toBe(2);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
    cpus.mockRestore();
  }
});

test("Closing Usage cancels workspace inspection and ignores responses after the screen is hidden", async () => {
  // OS inspection can finish after cancellation and must never reclaim the closed view.
  const pending =
    Promise.withResolvers<Result<readonly WorkspaceResourceSample[], CapabilityError>>();
  let signal: AbortSignal | undefined;
  const app = await mount({
    onWorkspaceResources: (abort) => {
      signal = abort;
      return pending.promise;
    },
  });
  try {
    await app.open();
    app.mockInput.pressEscape();
    await app.render();
    pending.resolve(ok([{ id: "late", name: "Late workspace", elapsedMs: 1000, processes: [] }]));
    await app.render();

    // Stale workspace data cannot revive the view or overwrite focus in the restored Agent.
    expect(signal?.aborted).toBe(true);
    expect(app.get("agent-dashboard").visible).toBe(false);
    expect(app.captureCharFrame()).not.toContain("Late workspace");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    pending.resolve(ok([]));
    await app.close();
  }
});

test("New filter results take precedence over slower earlier statistics", async () => {
  // Prepare distinct slow seven-day and fast thirty-day results.
  const old = Promise.withResolvers<Result<DashboardSnapshot, SessionError>>();
  const app = await mount({
    onDashboard: async (days) => {
      if (days === 7) {
        return old.promise;
      }

      const data = sample(days);
      data.totals.tokens = 9999;

      return ok(data);
    },
  });
  try {
    await app.open();
    app.get("dashboard-period").focus();

    // Prefer the new filter response over earlier requests.
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("9,999");
    old.resolve(ok(sample(7)));
    await app.render();

    // Late responses never restore old-period values or focus.
    expect(app.captureCharFrame()).toContain("9,999");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-period");
  } finally {
    old.resolve(ok(sample(7)));
    await app.close();
  }
});

test("Dashboard refresh retains prepared statistics while a small body indicator marks the pending request", async () => {
  // A new period must not replace useful statistics with a second full loading screen.
  const pending = Promise.withResolvers<Result<DashboardSnapshot, SessionError>>();
  const app = await mount({
    onDashboard: async (days) => (days === 7 ? ok(sample(7)) : pending.promise),
  });
  try {
    await app.open();
    app.get("dashboard-period").focus();

    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();

    expect(app.captureCharFrame()).toContain("1,240");
    expect(app.captureCharFrame()).not.toContain("Loading saved session statistics");
    expect(app.get("dashboard-loading").visible).toBe(true);
    expect(app.get("dashboard-loading-message").visible).toBe(false);

    const historyBody =
      app.renderer.root.findDescendantById("dashboard-history-body") ?? app.get("dashboard-body");
    expect(app.get("dashboard-loading").y).toBe(historyBody.y);
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-period");
    pending.resolve(ok(sample(30)));
    await app.render();
  } finally {
    pending.resolve(ok(sample(30)));
    await app.close();
  }
});

test("Dashboards show three summary metrics and charts, restoring drafts and input focus on close", async () => {
  // Start in real Workbench to ensure statistics never consume conversations or drafts.
  const app = await mount();
  try {
    app.input.value = "Retained draft";

    // Open and close read-only statistics using global shortcuts.
    await app.open();

    const frame = app.captureCharFrame();
    expect(frame).not.toContain("Agent Dashboard");
    expect(frame).toContain("Total tokens");
    expect(frame).toContain("Total run time");
    expect(frame).toContain("1,240");
    expect(frame).toContain("1m 5s");
    expect(frame).toContain("Radian resources");
    expect(frame).toContain("█");
    // Rankings remain reachable below the new live section without changing the draft.
    app.get("dashboard-category").focus();
    await app.render();
    expect(app.captureCharFrame()).toContain("write-good-code");
    app.mockInput.pressEscape();
    await app.render();

    // Return to original input ownership without model execution.
    expect(app.lookups.map((query) => query.days)).toEqual([7]);
    expect(app.sent).toEqual([]);
    expect(app.get("agent-dashboard").visible).toBe(false);
    expect(app.input.value).toBe("Retained draft");
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    await app.close();
  }
});

test("Resource tabs retain focus through repeated Ctrl+N/P and horizontal navigation and show correct units", async () => {
  // Each tab presents distinct data and units in shared bar-chart formats.
  const app = await mount();
  try {
    await app.open();
    app.get("dashboard-category").focus();

    // Navigate repeatedly inside the tab strip.
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("test/large");
    expect(app.captureCharFrame()).toContain("Model usage · tokens");
    app.mockInput.pressKey("ARROW_RIGHT");
    await app.render();
    expect(app.captureCharFrame()).toContain("figma-remote");
    app.mockInput.pressKey("l");
    await app.render();
    expect(app.captureCharFrame()).toContain("reviewer");
    app.mockInput.pressKey("p", { ctrl: true });
    app.mockInput.pressKey("ARROW_LEFT");
    await app.render();

    // One navigation key must not enter content; hints omit bare arrows.
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-category");
    expect(app.captureCharFrame()).toContain("test/large");

    const footer = app.captureCharFrame().split("\n").at(-2) ?? "";
    expect(footer).not.toContain("Right");
    expect(footer).not.toContain("Left");
  } finally {
    await app.close();
  }
});

test("Period and project changes reaggregate by scope while half-page navigation scrolls read-only bodies", async () => {
  // Long rankings remain readable by scrolling at any screen size.
  const queries: [DashboardPeriod, string | undefined][] = [];
  const app = await mount({
    onDashboard: async (days, project) => {
      queries.push([days, project]);

      const data = sample(days);
      data.skills = Array.from({ length: 80 }, (_, i) => ({ name: `skill-${i}`, value: 80 - i }));

      return ok(data);
    },
  });
  try {
    await app.open();
    app.get("dashboard-period").focus();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("30 days");
    app.get("dashboard-project").focus();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).not.toContain("Project ‹ All projects ›");
    expect(queries).toEqual([
      [7, undefined],
      [30, undefined],
      [30, "demo:radian"],
    ]);

    // Half-page navigation hands filter focus to the body and continues scrolling.
    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();

    const body = app.get("dashboard-body");
    if (!(body instanceof ScrollBoxRenderable)) {
      throw new Error("Missing scroll body");
    }

    const first = body.scrollTop;
    app.mockInput.pressKey("d", { ctrl: true });
    await app.render();

    // Keys never leak into the original Agent draft.
    expect(app.renderer.currentFocusedRenderable).toBe(body);
    expect(first).toBeGreaterThan(0);
    expect(body.scrollTop).toBeGreaterThan(first);
    expect(app.input.value).toBe("");
  } finally {
    await app.close();
  }
});

test("Custom dashboard navigation updates both behavior and footer hints", async () => {
  // Preserve explicit overrides replacing default Ctrl+N.
  const keymap = expectOk(
    parseKeymap({ bindings: { "dashboard.next": [{ keys: "q", scope: "dashboard-tabs" }] } }),
  );
  const app = await mount({ keymap });
  try {
    await app.open();
    app.get("dashboard-category").focus();

    // Old bindings stop moving tabs; only configured keys work.
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(app.captureCharFrame()).toContain("write-good-code");
    app.mockInput.pressKey("q");
    await app.render();

    // Visible hints match actual key behavior.
    expect(app.captureCharFrame()).toContain("test/large");
    expect(app.captureCharFrame()).toContain("q Next");
  } finally {
    await app.close();
  }
});

test("Closing pending dashboards cancels spinners and requests without late resurrection", async () => {
  // Prepare delayed queries users can close before results arrive.
  const pending = Promise.withResolvers<Result<DashboardSnapshot, SessionError>>();
  let signal: AbortSignal | undefined;
  const app = await mount({
    onDashboard: async (_days, _project, abort) => {
      signal = abort;

      return pending.promise;
    },
  });
  try {
    await app.open();
    expect(app.get("dashboard-loading").visible).toBe(true);

    // Close before reading completes, then deliver the response.
    app.mockInput.pressEscape();
    await app.render();
    pending.resolve(ok(sample()));
    await app.render();

    // Cancelled owners cannot reclaim focus or screens through late responses.
    expect(signal?.aborted).toBe(true);
    expect(app.get("dashboard-loading").visible).toBe(false);
    expect(app.get("agent-dashboard").visible).toBe(false);
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    pending.resolve(err(new SessionError("SESSION_BUSY", "Cancelled fixture")));
    await app.close();
  }
});

test("Compact dashboards distinguish empty data from lookup failures without invalid chart values", async () => {
  // No history and failed lookup are distinct outcomes.
  let fail = false;
  const app = await mount(
    {
      onDashboard: async (days) =>
        fail ? err(new SessionError("SESSION_BUSY", "Lookup failed")) : ok(emptyDashboard(days)),
    },
    50,
    18,
  );
  try {
    await app.open();
    expect(app.get("agent-dashboard").visible).toBe(true);
    expect(app.captureCharFrame()).not.toContain("NaN");
    app.get("dashboard-body").focus();
    app.mockInput.pressKey("END");
    await app.render();
    expect(app.captureCharFrame()).toContain("No recorded usage");

    // Failed refreshes must not display stale numbers or fabricated zero success.
    fail = true;
    app.mockInput.pressKey("r");
    await app.render();

    expect(app.captureCharFrame()).toContain("SESSION_BUSY");
    expect(app.captureCharFrame()).not.toContain("NaN");
  } finally {
    await app.close();
  }
});

test("Live resources sum UI and Runtime and keep their history independent of usage filters and focus", async () => {
  // Eight logical CPUs make the whole-machine percentages independent of the test host.
  const logicalCpus = spyOn(os, "cpus").mockReturnValue(
    Array.from({ length: 8 }, () => ({
      model: "Test CPU",
      speed: 1000,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    })),
  );
  let elapsedMs = 1000;
  let uiCpu = 0;
  let runtimeCpu = 0;
  let calls = 0;
  const cpu = spyOn(process, "cpuUsage").mockImplementation(() => ({ user: uiCpu, system: 0 }));
  const rss = spyOn(process.memoryUsage, "rss").mockReturnValue(85 * 1024 ** 2);
  const elapsed = spyOn(performance, "now").mockImplementation(() => elapsedMs);
  const app = await mount({
    onResources: async () => {
      calls++;

      return ok({
        pid: process.pid + 1,
        elapsedMs,
        cpuMicros: runtimeCpu,
        rssBytes: 320 * 1024 ** 2,
      });
    },
  });
  try {
    await app.open();
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-body");
    expect(app.captureCharFrame()).toContain("Radian resources · live");
    expect(app.captureCharFrame()).not.toContain("CPU: whole machine = 100%");

    const table = app.get("dashboard-resources-table");
    if (!(table instanceof TextRenderable)) {
      throw new Error("Missing resource table");
    }

    expect(table.plainText).toMatch(/Shared\s+—/);
    expect(table.plainText).toContain("405 MB");

    // Provider history filters must neither reset live samples nor move focus when polling completes.
    app.get("dashboard-period").focus();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(calls).toBe(1);

    const body = app.get("dashboard-body");
    if (!(body instanceof ScrollBoxRenderable)) {
      throw new Error("Missing dashboard body");
    }

    const scrollTop = body.scrollTop;
    elapsedMs = 2000;
    uiCpu = 1000000;
    runtimeCpu = 3000000;
    app.clock.advance(1000);
    await app.render();

    expect(table.plainText).toMatch(/Shared\s+50\.0%/);
    expect(table.plainText).toMatch(/UI\s+12\.5%/);
    expect(table.plainText).toMatch(/Runtime\s+37\.5%/);
    expect(table.plainText).toContain("405 MB");
    expect(table.plainText).toContain("▄");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-period");
    expect(body.scrollTop).toBe(scrollTop);
    app.get("dashboard-project").focus();
    app.mockInput.pressKey("n", { ctrl: true });
    await app.render();
    expect(table.plainText).toMatch(/Shared\s+50\.0%/);
    expect(calls).toBe(2);
    expect(app.sent).toEqual([]);
  } finally {
    await app.close();
    elapsed.mockRestore();
    rss.mockRestore();
    cpu.mockRestore();
    logicalCpus.mockRestore();
  }
});

test("Closing resource sampling aborts pending work and rejects late data across reopen", async () => {
  // A request that ignores cancellation must not overwrite a later popup lifetime.
  const pending = Promise.withResolvers<Result<ProcessResourceSample, CapabilityError>>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const app = await mount({
    onResources: async (abort) => {
      calls++;
      signal = abort;

      return calls === 1
        ? pending.promise
        : ok({ pid: process.pid + 1, elapsedMs: 1000, cpuMicros: 0, rssBytes: 320 * 1024 ** 2 });
    },
  });
  try {
    await app.open();
    expect(app.get("dashboard-resources-loading").visible).toBe(true);

    const feedback = app.get("dashboard-resources-loading-feedback");
    const table = app.get("dashboard-resources-table");

    expect(feedback.y).toBe(table.y + Math.floor((table.height - 1) / 2));
    expect(feedback.x).toBe(table.x + Math.floor((table.width - feedback.width) / 2));
    app.clock.advance(5000);
    await app.render();
    expect(calls).toBe(1);

    app.mockInput.pressEscape();
    await app.render();
    expect(signal?.aborted).toBe(true);
    expect(app.get("dashboard-resources-loading").visible).toBe(false);
    app.clock.advance(10000);
    await app.render();
    expect(calls).toBe(1);
    await app.open();
    pending.resolve(err(new CapabilityError("Stale resource failure")));
    await app.render();

    expect(calls).toBe(2);
    expect(app.captureCharFrame()).not.toContain("Stale resource failure");
    expect(app.get("dashboard-resources-error").visible).toBe(false);
    app.mockInput.pressEscape();
    await app.render();
    app.clock.advance(10000);
    await app.render();
    expect(calls).toBe(2);
  } finally {
    pending.resolve(err(new CapabilityError("Cancelled")));
    await app.close();
  }
});

test("Resizing live resources keeps memory and every process visible without clearing recent samples", async () => {
  // Wide and compact layouts share the same resource history and never trigger extra sampling.
  const app = await mount();
  try {
    await app.open();

    const table = app.get("dashboard-resources-table");
    if (!(table instanceof TextRenderable)) {
      throw new Error("Missing resource table");
    }

    expect(table.plainText).toContain("··");

    app.resize(50, 18);
    await app.render();

    // Native geometry updates one frame later; column sizing must already use the requested width.
    const frame = app.captureCharFrame();
    expect(frame).toContain("RAM");
    expect(frame).toContain("Runtime");
    expect(frame).toContain("320 MB");
    expect(table.plainText).not.toContain("··");
    expect(app.renderer.currentFocusedRenderable?.id).toBe("dashboard-body");
    app.resize(120, 32);
    await app.render();
    expect(table.plainText).toContain("··");
    expect(table.plainText).toContain("320 MB");
    expect(app.lookups).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("Resource failures leave usage history usable and compact layouts retain every process row", async () => {
  // An older daemon may not support metrics, but its saved usage is still useful.
  const app = await mount(
    { onResources: async () => err(new CapabilityError("Resource metrics unsupported")) },
    50,
    18,
  );
  try {
    await app.open();

    const table = app.get("dashboard-resources-table");
    if (!(table instanceof TextRenderable)) {
      throw new Error("Missing resource table");
    }

    // Narrow layouts omit sparklines, never the process breakdown or unknown-value markers.
    expect(table.plainText).toContain("Shared");
    expect(table.plainText).toContain("UI");
    expect(table.plainText).toContain("Runtime");
    expect(table.plainText).not.toContain("··");
    expect(table.plainText).not.toContain("NaN");
    expect(app.get("dashboard-resources-error").visible).toBe(true);
    app.get("dashboard-category").focus();
    await app.render();
    expect(app.captureCharFrame()).toContain("write-good-code");
    app.mockInput.pressEscape();
    await app.render();
    expect(app.renderer.currentFocusedRenderable).toBe(app.input);
  } finally {
    await app.close();
  }
});
