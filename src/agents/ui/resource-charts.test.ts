import { expect, test } from "bun:test";
import { resourceCpu, resourceMemory, resourceSparkline } from "./resource-charts.ts";
import type { ResourcePoint } from "../../usage/process-resources.ts";

test("Resource values distinguish unknown metrics from zero and format whole-machine CPU shares", () => {
  // Missing counters and real zero usage have different meanings.
  expect(resourceCpu(null)).toBe("—");
  expect(resourceCpu(0)).toBe("0.0%");
  expect(resourceCpu(12.5)).toBe("12.5%");
  expect(resourceCpu(21.875)).toBe("21.9%");
  expect(resourceCpu(100)).toBe("100.0%");
  expect(resourceMemory(undefined)).toBe("—");
  expect(resourceMemory(0)).toBe("0 KB");
  expect(resourceMemory(405 * 1024 ** 2)).toBe("405 MB");
  expect(resourceMemory(1.5 * 1024 ** 3)).toBe("1.50 GB");
});

test("CPU sparklines keep 100 percent as the full-machine scale during partial usage", () => {
  // A quiet history must not stretch partial CPU shares into full-height bars.
  const points: ResourcePoint[] = [
    { at: 0, total: { cpuPercent: 25, rssBytes: 100 } },
    { at: 30000, total: { cpuPercent: 50, rssBytes: 100 } },
  ];

  // Both samples occupy distinct chronological buckets within the latest minute.
  const line = resourceSparkline(points, "cpuPercent", 2, 30000);

  // A 50% share remains half-height rather than becoming the history's relative maximum.
  expect(line).toBe("▂▄");
});

test("Sparklines use chronological time buckets and leave unavailable samples as gaps", () => {
  // Missing intervals must not be squeezed out or fabricated as zero usage.
  const points: ResourcePoint[] = [
    { at: 0, total: { cpuPercent: 100, rssBytes: 100 } },
    { at: 10000, total: { cpuPercent: 0, rssBytes: 100 } },
    { at: 30000, total: { cpuPercent: 50, rssBytes: 100 } },
    { at: 40000, total: null },
    { at: 60000, total: { cpuPercent: 100, rssBytes: 100 } },
  ];

  const line = resourceSparkline(points, "cpuPercent", 6, 60000);

  // The expired first point disappears; the newest point occupies the right edge.
  expect(line).toBe("▁·▄··█");
  expect(resourceSparkline([], "rssBytes", 4, 60000)).toBe("····");
  expect(resourceSparkline(points, "cpuPercent", 0, 60000)).toBe("");
});
