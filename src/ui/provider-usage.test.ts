import { expect, spyOn, test } from "bun:test";
import type { TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { parseAnthropicUsage } from "../usage/providers/anthropic.ts";
import { parseOpenAiUsage } from "../usage/providers/openai.ts";
import type { ProviderUsage } from "../usage/model.ts";
import { expectOk } from "../testing/results.ts";
import { icons } from "../icons.ts";
import { Footer } from "./footer.ts";

const now = 1800000000000;
function quotas(): Record<string, ProviderUsage> {
  return {
    "openai-codex": {
      provider: "openai",
      status: "ready",
      windows: expectOk(
        parseOpenAiUsage({
          rate_limit: {
            secondary_window: {
              used_percent: 18,
              limit_window_seconds: 604800,
              reset_at: now / 1000 + 3600,
            },
          },
        }),
      ),
      updatedAt: now,
      errorCode: null,
    },
    anthropic: {
      provider: "anthropic",
      status: "ready",
      windows: expectOk(
        parseAnthropicUsage({
          five_hour: { utilization: 99, resets_at: new Date(now + 3600000).toISOString() },
          seven_day: { utilization: 64, resets_at: new Date(now + 143 * 3600000).toISOString() },
          seven_day_sonnet: { utilization: 100, resets_at: new Date(now + 86400000).toISOString() },
        }),
      ),
      updatedAt: now,
      errorCode: null,
    },
  };
}

async function mount() {
  const date = spyOn(Date, "now").mockReturnValue(now);
  const clock = new ManualClock();
  const app = await createTestRenderer({ width: 140, height: 4, clock });
  const footer = new Footer(app.renderer);
  app.renderer.root.add(footer.root);
  footer.setUsage(quotas(), ["openai-codex", "anthropic"]);
  await app.renderOnce();

  return {
    ...app,
    footer,
    clock,
    line: () => app.captureCharFrame().split("\n")[footer.bar.y]!,
    async close() {
      await app.dispose();
      date.mockRestore();
    },
  };
}

test("Global status renders normalized Claude and OpenAI quotas with independent reset countdowns", async () => {
  // Source parsers provide separate weekly windows even while Claude's short window is nearly exhausted.
  const app = await mount();
  try {
    await app.renderOnce();

    // Both providers remain visible without selecting a model or exposing long provider labels.
    expect(app.line()).toContain(icons.openai);
    expect(app.line()).toContain(icons.claude);
    expect(app.line()).toContain("18% used 1h 0m");
    expect(app.line()).toContain("64% used 5d 23h");
    expect(app.line()).not.toMatch(/99%|100%|chatgpt|claude|openai|anthropic|context/u);
    expect(app.renderer.root.findDescendantById("footer-provider-icon-openai-codex")?.visible).toBe(
      true,
    );
    expect(app.renderer.root.findDescendantById("footer-provider-icon-anthropic")?.visible).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

test.each(["loading", "error"] as const)(
  "Claude %s keeps its recovery indicator beside Claude without hiding OpenAI values",
  async (status) => {
    // One source may recover independently while the other continues to report a known percentage.
    const app = await mount();
    try {
      const values = quotas();
      app.footer.setUsage({ ...values, anthropic: { ...values.anthropic!, status } }, [
        "openai-codex",
        "anthropic",
      ]);
      await app.renderOnce();
      const claude = app.renderer.root.findDescendantById("footer-provider-icon-anthropic")!;
      const spinner = app.renderer.root.findDescendantById(
        "footer-usage-loading-anthropic",
      ) as TextRenderable;
      const openaiSpinner = app.renderer.root.findDescendantById(
        "footer-usage-loading-openai-codex",
      )!;

      // A stale Claude percentage must not masquerade as fresh usage or replace OpenAI's successful result.
      expect(app.line()).toContain("18% used 1h 0m");
      expect(app.line()).not.toContain("64% used");
      expect(spinner.visible).toBe(true);
      expect(spinner.x).toBeGreaterThanOrEqual(claude.x + claude.width);
      expect(openaiSpinner.visible).toBe(false);

      // Fresh results appear immediately while the shared minimum-visible animation completes separately.
      app.footer.setUsage(values, ["openai-codex", "anthropic"]);
      await app.renderOnce();
      expect(app.line()).toContain("64% used 5d 23h");
      expect(app.line()).toContain("18% used 1h 0m");
      app.clock.advance(500);
      await app.renderOnce();
      expect(spinner.visible).toBe(false);
    } finally {
      await app.close();
    }
  },
);

test("Both quota ratios survive compact global status layouts and restore their countdowns", async () => {
  // The footer is shared by all work views, so width changes must not lose either provider's known usage.
  const app = await mount();
  try {
    for (const width of [140, 80, 60, 40, 30, 140]) {
      app.resize(width, 4);
      await app.renderOnce();

      expect(app.line()).toContain(icons.openai);
      expect(app.line()).toContain(icons.claude);
      expect(app.line()).toContain("18%");
      expect(app.line()).toContain("64%");
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
    }
    expect(app.line()).toContain("1h 0m");
    expect(app.line()).toContain("5d 23h");
  } finally {
    await app.close();
  }
});

test("Long extension status and workspace identity cannot displace known provider ratios", async () => {
  // Global status metadata shares the row but must not make logged-in provider usage disappear.
  const app = await mount();
  try {
    app.footer.setWorkspace({ name: "radian", branch: "main" });
    app.footer.setContext("Extension status ".repeat(20));

    for (const width of [140, 40, 140]) {
      app.resize(width, 4);
      await app.renderOnce();

      expect(app.line()).toContain(icons.openai);
      expect(app.line()).toContain(icons.claude);
      expect(app.line()).toContain("18%");
      expect(app.line()).toContain("64%");
      expect(Bun.stringWidth(app.line())).toBeLessThanOrEqual(width);
    }
  } finally {
    await app.close();
  }
});

test("Removing a connected quota destroys only its logo and recovery timers", async () => {
  // Account removal may arrive while that provider is waiting to retry its own usage query.
  const app = await mount();
  try {
    const values = quotas();
    app.footer.setUsage({ ...values, anthropic: { ...values.anthropic!, status: "error" } }, [
      "openai-codex",
      "anthropic",
    ]);
    await app.renderOnce();
    const spinner = app.renderer.root.findDescendantById("footer-usage-loading-anthropic")!;
    expect(spinner.visible).toBe(true);

    app.footer.setUsage({ "openai-codex": values["openai-codex"]! }, ["openai-codex"]);
    await app.renderOnce();

    expect(spinner.isDestroyed).toBe(true);
    expect(app.line()).not.toContain(icons.claude);
    expect(app.line()).toContain(icons.openai);
    expect(app.line()).toContain("18% used 1h 0m");
    expect(app.renderer.root.findDescendantById("footer-usage-loading-anthropic")).toBeUndefined();

    // Destroying the global status cancels the remaining local countdown without any network action.
    app.footer.root.destroyRecursively();
    app.clock.advance(20);
    await app.renderOnce();
    expect(app.clock.pendingTimerCount).toBe(0);
  } finally {
    await app.close();
  }
});
