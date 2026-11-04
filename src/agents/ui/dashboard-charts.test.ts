import { expect, test } from "bun:test";
import { emptyDashboard, type DashboardAgentUsage } from "../dashboard.ts";
import {
  dashboardAgents,
  dashboardBars,
  dashboardTrend,
  dashboardValue,
} from "./dashboard-charts.ts";

test("Inactive graphs retain zero values and dates without drawing fabricated activity", () => {
  // Empty data is a valid zero, unlike missing-data errors.
  const snapshot = emptyDashboard(7, new Date(2026, 2, 22, 12).getTime());

  // Render daily graphs and empty rankings as screen text.
  const trend = dashboardTrend(snapshot.daily, "tokens", 80).join("\n");
  const bars = dashboardBars([], 80);

  // Never produce invalid ratios or fake activity.
  expect(trend).toContain("0");
  expect(trend).toContain("03-22");
  expect(trend).not.toContain("█");
  expect(trend).not.toContain("NaN");
  expect(bars).toEqual(["No recorded usage in this period."]);
});

test.each([20, 40, 80, 112])(
  "%d-column charts fit terminal cells with Korean/emoji names and large values",
  (width) => {
    // Layout uses terminal cell widths, not string lengths.
    const rows = [
      { name: "한글 스킬 👩🏽‍💻 긴 이름이 계속됩니다", value: 123456 },
      { name: "review-code", value: 200 },
    ];
    const snapshot = emptyDashboard(30);

    snapshot.daily[0]!.tokens = 123456;

    // Compact long rankings and 30-day trends in narrow layouts.
    const lines = [
      ...dashboardBars(rows, width),
      ...dashboardTrend(snapshot.daily, "tokens", width),
    ];

    // Boundaries must neither split graphemes nor overflow.
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    }

    expect(lines.join("\n")).not.toContain("NaN");
  },
);

test("Run durations and tokens display distinct units", () => {
  // Displaying milliseconds like tokens would change the metric's meaning.
  const durationMs = 3661000;
  const tokens = 123456;

  // Convert metrics independently at the shared summary-format boundary.
  const time = dashboardValue(durationMs, "durationMs");
  const consumption = dashboardValue(tokens);

  // Durations use hours/minutes; tokens retain exact counts.
  expect(time).toBe("1h 1m");
  expect(consumption).toBe("123,456");
});

test.each([40, 80, 112])(
  "%d-column agent tables preserve component values and terminal cell bounds",
  (width) => {
    // Unicode profiles and large counts must not displace adjacent numeric columns.
    const rows: DashboardAgentUsage[] = [
      {
        kind: "profile",
        name: "한글 👩🏽‍💻 engineer",
        value: 123456,
        input: 100000,
        output: 20000,
        cacheRead: 3000,
        cacheWrite: 456,
      },
      { kind: "unattributed", name: "Unattributed", value: 10 },
    ];

    // Wide tables become stacked rows when all five values cannot fit beside the name.
    const lines = dashboardAgents(rows, width);

    // Unknown components remain unknown, and every component stays visible at supported widths.
    for (const text of ["123,456", "100,000", "20,000", "3,000", "456", "—"]) {
      expect(lines.join("\n")).toContain(text);
    }
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  },
);
