import {
  resourceWindowMs,
  type ResourcePoint,
  type ResourceValues,
} from "../../usage/process-resources.ts";

export function resourceCpu(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

export function resourceMemory(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "—";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function resourceSparkline(
  points: readonly ResourcePoint[],
  metric: keyof ResourceValues,
  width: number,
  now: number,
): string {
  if (width < 1) {
    return "";
  }

  const buckets: (number | null)[] = Array.from({ length: width }, () => null);
  for (const point of points) {
    const age = now - point.at;
    if (age < 0 || age >= resourceWindowMs) {
      continue;
    }

    const index = width - 1 - Math.floor((age / resourceWindowMs) * width);
    buckets[index] = point.total?.[metric] ?? null;
  }

  const maximum = Math.max(
    metric === "cpuPercent" ? 100 : 1,
    ...buckets.map((value) => value ?? 0),
  );
  const bars = "▁▂▃▄▅▆▇█";

  return buckets
    .map((value) => (value === null ? "·" : bars[Math.min(7, Math.floor((value / maximum) * 7))]))
    .join("");
}
