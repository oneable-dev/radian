import { cpus } from "node:os";
import { Type, type Static } from "typebox";
import { ResourceError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { WorkspaceResourceSample } from "./workspace-resources.ts";

const counter = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const processResourceSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  elapsedMs: counter,
  cpuMicros: counter,
  rssBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export type ProcessResourceSample = Static<typeof processResourceSchema>;

export type ResourceValues = { cpuPercent: number | null; rssBytes: number };

export type ResourcePoint = { at: number; total: ResourceValues | null };

export type WorkspaceResourceValues = { id: string; name: string; value: ResourceValues | null };

export type ResourceSnapshot = ResourcePoint & {
  ui: ResourceValues | null;
  runtime: ResourceValues | null;
  workspaces: readonly WorkspaceResourceValues[];
};

export type ResourceLoader = (
  signal: AbortSignal,
) => Promise<Result<ProcessResourceSample, ExpectedError>>;

export const resourceWindowMs = 60000;

// Read only this process. Child processes and machine-wide counters are deliberately excluded.
export function readProcessResources(): Result<ProcessResourceSample, ResourceError> {
  try {
    const cpu = process.cpuUsage();

    return ok({
      pid: process.pid,
      elapsedMs: performance.now(),
      cpuMicros: cpu.user + cpu.system,
      rssBytes: process.memoryUsage.rss(),
    });
  } catch (cause) {
    return err(new ResourceError("Could not read process CPU or resident memory.", { cause }));
  }
}

function values(
  current: ProcessResourceSample | null,
  previous: ProcessResourceSample | null,
  cpuCount: number,
): ResourceValues | null {
  if (!current) {
    return null;
  }

  const elapsed = previous ? current.elapsedMs - previous.elapsedMs : 0;
  const cpu = previous ? current.cpuMicros - previous.cpuMicros : -1;

  return {
    // All logical CPUs together are 100%; a single busy CPU contributes only its machine share.
    cpuPercent:
      previous?.pid === current.pid && elapsed > 0 && cpu >= 0 && cpuCount > 0
        ? cpu / (elapsed * 10 * cpuCount)
        : null,
    rssBytes: current.rssBytes,
  };
}

export class ResourceHistory {
  private ui: ProcessResourceSample | null = null;
  private runtime: ProcessResourceSample | null = null;
  private points: ResourcePoint[] = [];
  private workspaces = new Map<string, WorkspaceResourceSample>();

  // The UI and shared Runtime run on the same machine and use one capacity denominator.
  constructor(private readonly cpuCount = cpus().length) {}

  get recent(): readonly ResourcePoint[] {
    return this.points;
  }

  add(
    ui: ProcessResourceSample | null,
    runtime: ProcessResourceSample | null,
    at = Date.now(),
    workspaceSamples: readonly WorkspaceResourceSample[] | null = null,
  ): ResourceSnapshot {
    const uiValues = values(ui, this.ui, this.cpuCount);
    const runtimeValues = values(runtime, this.runtime, this.cpuCount);
    const total =
      uiValues && runtimeValues && ui?.pid !== runtime?.pid
        ? {
            cpuPercent:
              uiValues.cpuPercent !== null && runtimeValues.cpuPercent !== null
                ? uiValues.cpuPercent + runtimeValues.cpuPercent
                : null,
            rssBytes: uiValues.rssBytes + runtimeValues.rssBytes,
          }
        : null;

    this.ui = ui;
    this.runtime = runtime;

    const samples =
      workspaceSamples ??
      [...this.workspaces.values()].map((sample) => ({ ...sample, processes: null }));
    const workspaces = samples.map((sample): WorkspaceResourceValues => {
      const previous = this.workspaces.get(sample.id);
      const byPid = new Map(previous?.processes?.map((item) => [item.pid, item]));
      const processes = sample.processes?.map((item) => {
        const old = byPid.get(item.pid);

        return values(
          { ...item, elapsedMs: sample.elapsedMs },
          old && old.started === item.started && previous
            ? { ...old, elapsedMs: previous.elapsedMs }
            : null,
          this.cpuCount,
        )!;
      });

      return {
        id: sample.id,
        name: sample.name,
        value: processes
          ? {
              cpuPercent: processes.reduce<number | null>(
                (sum, item) =>
                  sum === null || item.cpuPercent === null ? null : sum + item.cpuPercent,
                0,
              ),
              rssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
            }
          : null,
      };
    });
    this.workspaces = new Map(samples.map((sample) => [sample.id, sample]));

    const snapshot = { at, ui: uiValues, runtime: runtimeValues, total, workspaces };
    this.points = [
      ...this.points.filter((point) => point.at > at - resourceWindowMs),
      { at, total },
    ].slice(-61);

    return snapshot;
  }
}
