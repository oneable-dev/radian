import { open, realpath } from "node:fs/promises";
import { CancelledError, capture, HistoryError, parseJson, withCleanup, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { DashboardAccumulator, type DashboardPeriod, type DashboardSnapshot } from "./dashboard.ts";

const chunkBytes = 64 * 1024;
const maximumRecordBytes = 16 * 1024 * 1024;
type HistorySummary = { snapshot: DashboardSnapshot; identities: ReadonlySet<string> };

// Read-only, bounded streaming scan. Never open an SDK writer or deserialize the whole conversation.
export async function readDashboardHistory(path: string, cwd: string, days: DashboardPeriod, now: number,
  seen: ReadonlySet<string>, signal?: AbortSignal): Promise<Result<HistorySummary, ExpectedError>> {
  if (signal?.aborted) return err(new CancelledError());
  const expectedCwd = await capture(() => realpath(cwd)); if (!expectedCwd.ok) return expectedCwd;
  const opened = await capture(() => open(path, "r")); if (!opened.ok) return opened;
  return withCleanup(async () => {
    const file = opened.value, metadata = await capture(() => file.stat()); if (!metadata.ok) return metadata;
    const accumulator = new DashboardAccumulator(days, expectedCwd.value, now, seen);
    let pending: Buffer[] = [], pendingBytes = 0, position = 0, header = false;
    const consume = async (line: Buffer): Promise<Result<void, ExpectedError>> => {
      if (!line.length) return ok(undefined);
      const decoded = parseJson(line.toString("utf8"), "dashboard history");
      if (!decoded.ok) return err(new HistoryError("HISTORY_CORRUPT", "Saved conversation contains invalid JSON.", { cause: decoded.error }));
      const entry = decoded.value;
      if (!header) {
        if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "session" || !("cwd" in entry) || typeof entry.cwd !== "string")
          return err(new HistoryError("HISTORY_CORRUPT", "Saved conversation has no workspace header."));
        const headerCwd = entry.cwd;
        const scope = await capture(() => realpath(headerCwd)); if (!scope.ok) return scope;
        if (scope.value !== expectedCwd.value) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved conversation belongs to a different workspace."));
        header = true; return ok(undefined);
      }
      return accumulator.add(entry);
    };
    while (position < metadata.value.size) {
      if (signal?.aborted) return err(new CancelledError());
      const buffer = Buffer.alloc(Math.min(chunkBytes, metadata.value.size - position));
      const read = await capture(() => file.read(buffer, 0, buffer.length, position)); if (!read.ok) return read;
      if (!read.value.bytesRead) return err(new HistoryError("HISTORY_UNAVAILABLE", "Saved conversation changed during dashboard lookup."));
      position += read.value.bytesRead;
      const chunk = buffer.subarray(0, read.value.bytesRead);
      let start = 0, end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, end), length = pendingBytes + part.length;
        if (length > maximumRecordBytes) return err(new HistoryError("HISTORY_UNAVAILABLE", "A saved record is too large for dashboard lookup."));
        const result = await consume(pendingBytes ? Buffer.concat([...pending, part], length) : part); if (!result.ok) return result;
        pending = []; pendingBytes = 0; start = end + 1;
      }
      if (start < chunk.length) { const part = chunk.subarray(start); pending.push(part); pendingBytes += part.length; }
      if (pendingBytes > maximumRecordBytes) return err(new HistoryError("HISTORY_UNAVAILABLE", "A saved record is too large for dashboard lookup."));
    }
    // A snapshot may end between a writer's bytes. Do not silently treat partial history as complete.
    if (pendingBytes) { const result = await consume(Buffer.concat(pending, pendingBytes)); if (!result.ok) return result; }
    if (!header) return err(new HistoryError("HISTORY_CORRUPT", "Saved conversation is empty."));
    return ok({ snapshot: accumulator.finish(), identities: accumulator.identities });
  }, () => opened.value.close());
}
