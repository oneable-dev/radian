import type { FileHandle } from "node:fs/promises";
import { CancelledError, HistoryError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

type Line = { readonly start: number; readonly end: number };

export const historyReadChunk = 64 * 1024;

export function historyReadFailure(
  signal: AbortSignal | undefined,
  deadline: number,
): ExpectedError | undefined {
  if (signal?.aborted) {
    return new CancelledError();
  }
  if (Date.now() >= deadline) {
    return new HistoryError(
      "HISTORY_UNAVAILABLE",
      "Recent history lookup timed out. The session remains available to open explicitly.",
    );
  }

  return undefined;
}

// File size is a snapshot. A concurrent truncation is not silently treated as an empty history.
// SDK/OS exceptions are classified by the owning file-operation boundary.
export async function readHistoryBytes(
  file: FileHandle,
  start: number,
  length: number,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<Result<Buffer, ExpectedError>> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const failure = historyReadFailure(signal, deadline);
    if (failure) {
      return err(failure);
    }

    const read = await file.read(
      bytes,
      offset,
      Math.min(historyReadChunk, length - offset),
      start + offset,
    );
    if (!read.bytesRead) {
      return err(
        new HistoryError(
          "HISTORY_UNAVAILABLE",
          "Saved conversation changed while reading its preview. Refresh history.",
        ),
      );
    }

    offset += read.bytesRead;
  }

  return ok(bytes);
}

// Scan newline offsets backwards, never concatenating a whole file or a huge old JSONL record.
// Callers read/decode only the records necessary for the recent active branch.
export async function* reverseHistoryLines(
  file: FileHandle,
  size: number,
  signal: AbortSignal | undefined,
  deadline: number,
): AsyncGenerator<Result<Line, ExpectedError>> {
  let position = size;
  let end = size;
  while (position > 0) {
    const start = Math.max(0, position - historyReadChunk);
    const read = await readHistoryBytes(file, start, position - start, signal, deadline);
    if (!read.ok) {
      yield read;

      return;
    }
    for (let index = read.value.length - 1; index >= 0; index--) {
      if (read.value[index] !== 10) {
        continue;
      }

      const next = start + index + 1;
      if (next < end) {
        yield ok({ start: next, end });
      }

      end = start + index;
    }

    position = start;
  }
  if (end > 0) {
    yield ok({ start: 0, end });
  }
}
