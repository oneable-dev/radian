import type { DashboardMetric, DashboardRanking, DashboardSnapshot } from "../dashboard.ts";
import { singleLine, truncateCells } from "../../ui/text.ts";

export function dashboardValue(value: number, metric: DashboardMetric = "tokens"): string {
  if (metric !== "durationMs") {
    return Math.round(value).toLocaleString("en-US");
  }

  const seconds = Math.floor(value / 1000);
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  } else if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

const compact = (value: number, metric: DashboardMetric) =>
  metric === "durationMs"
    ? dashboardValue(value, metric)
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
        value,
      );

export function dashboardTrend(
  daily: DashboardSnapshot["daily"],
  metric: DashboardMetric,
  width: number,
  height = 4,
): string[] {
  if (width < 8 || !daily.length) {
    return [];
  }

  const capacity = Math.max(1, Math.floor((width - 9) / 2));
  const stride = Math.ceil(daily.length / capacity);
  const values: number[] = [];
  for (let index = 0; index < daily.length; index += stride) {
    values.push(daily.slice(index, index + stride).reduce((sum, day) => sum + day[metric], 0));
  }

  const maximum = Math.max(0, ...values);
  const axisWidth = Math.min(9, Math.max(4, Bun.stringWidth(compact(maximum, metric)) + 1));
  const columnWidth = Math.max(1, Math.floor((width - axisWidth - 2) / values.length));
  const lines: string[] = [];
  for (let row = height; row > 0; row--) {
    const axis = row === height ? truncateCells(compact(maximum, metric), axisWidth - 1) : "";
    const bars = values
      .map((value) => {
        const filled = maximum > 0 && Math.ceil((value / maximum) * height) >= row;

        return filled
          ? "█".repeat(Math.max(1, columnWidth - 1)) + (columnWidth > 1 ? " " : "")
          : " ".repeat(columnWidth);
      })
      .join("")
      .trimEnd();

    lines.push(truncateCells(axis.padStart(axisWidth) + "│ " + bars, width));
  }

  const start = daily[0]!.date.slice(5);
  const end = daily.at(-1)!.date.slice(5);
  const range = start === end ? start : `${start} → ${end}`;
  const labels =
    columnWidth >= 6
      ? values
          .map((_, index) => daily[index * stride]!.date.slice(5).padEnd(columnWidth))
          .join("")
          .trimEnd()
      : range + (stride > 1 ? ` · ${stride}-day buckets` : " · daily");

  lines.push(truncateCells(" ".repeat(axisWidth + 2) + labels, width));

  return lines;
}

export function dashboardBars(rows: DashboardRanking, width: number): string[] {
  if (!rows.length) {
    return ["No recorded usage in this period."];
  }

  const maximum = Math.max(0, ...rows.map((row) => row.value));
  const valuesWidth = Math.max(...rows.map((row) => Bun.stringWidth(dashboardValue(row.value))));
  const labelWidth = Math.max(1, Math.min(34, Math.floor(width * 0.4), width - valuesWidth - 5));
  const barWidth = Math.max(0, width - labelWidth - valuesWidth - 4);

  return rows.map((row) => {
    const name = truncateCells(singleLine(row.name), labelWidth);
    const padding = " ".repeat(Math.max(0, labelWidth - Bun.stringWidth(name)));
    const filled =
      maximum > 0 && row.value > 0 ? Math.max(1, Math.round((row.value / maximum) * barWidth)) : 0;

    return truncateCells(
      `${name}${padding}  ${"█".repeat(Math.min(barWidth, filled))}${"░".repeat(Math.max(0, barWidth - filled))}  ${dashboardValue(row.value).padStart(valuesWidth)}`,
      width,
    );
  });
}
