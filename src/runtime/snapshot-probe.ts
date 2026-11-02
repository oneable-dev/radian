import { ConnectionError, systemCode, type ExpectedError } from "../errors.ts";
import { err, type Result } from "../result.ts";
import { fetchSnapshot } from "./client.ts";
import type { RuntimeSnapshot } from "./protocol.ts";
import type { RuntimePaths } from "./storage.ts";

// The last timeout and jitter bound repeat until the caller's deadline.
const timeouts = [500, 1000, 2000] as const;
const jitterBounds = [100, 200, 400] as const;

type ProbeDependencies = {
  fetchSnapshot: typeof fetchSnapshot;
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

const defaults: ProbeDependencies = {
  fetchSnapshot,
  now: Date.now,
  random: Math.random,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

// One observation owns its retries. Valid starting/stopping replies belong to phase polling.
// A daemon restoring sessions can block its event loop for seconds, so retries last until the deadline.
export async function probeSnapshot(
  paths: RuntimePaths,
  deadline: number,
  dependencies: ProbeDependencies = defaults,
): Promise<Result<RuntimeSnapshot | null, ExpectedError>> {
  let failure: ExpectedError = new ConnectionError(
    "CONNECTION_TIMEOUT",
    "Snapshot observation deadline expired; lifecycle completion is not confirmed.",
  );
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      const remaining = deadline - dependencies.now();
      if (remaining <= 0) break;
      const bound = jitterBounds[Math.min(attempt, jitterBounds.length) - 1]!;
      const delay = Math.min(dependencies.random() * bound, remaining);
      if (delay > 0) await dependencies.sleep(delay);
    }
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) break;
    const timeout = timeouts[Math.min(attempt, timeouts.length - 1)]!;
    const result = await dependencies.fetchSnapshot(paths, Math.min(timeout, remaining));
    if (result.ok) return result;
    failure = result.error;
    if (!retryable(failure)) return result;
  }

  return err(
    new ConnectionError(
      failure instanceof ConnectionError ? failure.code : "CONNECTION_TIMEOUT",
      "Snapshot observation failed; lifecycle completion is not confirmed. No lifecycle command was replayed.",
      { cause: failure },
    ),
  );
}

function retryable(error: ExpectedError): boolean {
  if (!(error instanceof ConnectionError)) return false;
  if (error.code === "CONNECTION_TIMEOUT") return true;
  return (
    error.code === "CONNECTION_FAILED" &&
    ["ECONNRESET", "EPIPE"].includes(systemCode(error.cause) ?? "")
  );
}
