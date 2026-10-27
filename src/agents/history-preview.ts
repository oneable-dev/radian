import { open, realpath } from "node:fs/promises";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CancelledError,
  capture,
  HistoryError,
  parseJson,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

import { SessionTranscript, type TranscriptSection } from "./transcript.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import type { SessionRecord } from "./session-registry.ts";
import { parseRunCompletion, runCompletionEntryType } from "./run-completion.ts";
import {
  historyReadChunk,
  historyReadFailure,
  readHistoryBytes,
  reverseHistoryLines,
} from "./history-lines.ts";

export type HistoryPreview = {
  readonly id: string;
  readonly worktreeId: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly sections?: readonly TranscriptSection[];
  readonly telemetry?: SessionTelemetry;
  readonly snapshot?: SessionRecord;
};
export const historyPreviewLimit = 65536;
export const historyPreviewSectionLimit = 8192;
export const historyPreviewSectionCount = 15;
const recordLimit = 16 * 1024 * 1024;
const retainedLimit = 32 * 1024 * 1024;
const corrupt = (message: string) => err(new HistoryError("HISTORY_CORRUPT", message));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validateContent(content: unknown): Result<void, HistoryError> {
  if (typeof content === "string") return ok(undefined);
  if (!Array.isArray(content)) return corrupt("Saved message has invalid content.");
  for (const part of content) {
    if (!object(part) || typeof part.type !== "string")
      return corrupt("Saved message has an invalid content block.");
    if (part.type === "text" && typeof part.text !== "string")
      return corrupt("Saved message has invalid text.");
  }
  return ok(undefined);
}

function validateEntry(entry: SessionEntry): Result<void, HistoryError> {
  if (entry.type === "model_change")
    return typeof entry.provider === "string" && typeof entry.modelId === "string"
      ? ok(undefined)
      : corrupt("Invalid saved model.");
  if (entry.type === "thinking_level_change")
    return typeof entry.thinkingLevel === "string"
      ? ok(undefined)
      : corrupt("Invalid saved thinking level.");
  if (entry.type === "custom" && entry.customType === runCompletionEntryType) {
    const completion = parseRunCompletion(entry.data);
    return completion.ok ? ok(undefined) : completion;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return typeof entry.summary === "string" ? ok(undefined) : corrupt("Invalid saved summary.");
  if (entry.type === "custom_message") {
    if (typeof entry.customType !== "string") return corrupt("Invalid saved custom message.");
    return validateContent(entry.content);
  }
  if (entry.type !== "message") return ok(undefined);
  const message: unknown = entry.message;
  if (!object(message) || typeof message.role !== "string")
    return corrupt("Invalid saved message.");
  if (message.errorMessage !== undefined && typeof message.errorMessage !== "string")
    return corrupt("Invalid saved message error.");
  switch (message.role) {
    case "assistant": {
      if (!Array.isArray(message.content))
        return corrupt("Saved Agent message has invalid content.");
      for (const part of message.content) {
        if (!object(part) || typeof part.type !== "string")
          return corrupt("Invalid saved Agent block.");
        if (part.type === "thinking" && part.redacted !== true && typeof part.thinking !== "string")
          return corrupt("Invalid saved thinking block.");
        if (
          part.type === "toolCall" &&
          (typeof part.id !== "string" ||
            !part.id ||
            part.id.length > 4096 ||
            typeof part.name !== "string")
        )
          return corrupt("Invalid saved tool call.");
      }
      break;
    }
    case "toolResult":
      if (
        typeof message.toolCallId !== "string" ||
        !message.toolCallId ||
        message.toolCallId.length > 4096 ||
        typeof message.toolName !== "string" ||
        (message.isError !== undefined && typeof message.isError !== "boolean")
      )
        return corrupt("Invalid saved tool result.");
      break;
    case "bashExecution":
      return typeof message.command === "string" && typeof message.output === "string"
        ? ok(undefined)
        : corrupt("Invalid saved shell result.");
    case "hookMessage":
    case "custom":
      if (typeof message.customType !== "string") return corrupt("Invalid saved custom message.");
      break;
    case "user":
      break;
    default:
      return ok(undefined);
  }
  return validateContent(message.content);
}

function clip(text: string, limit: number): string {
  const result = text.slice(0, limit),
    last = result.charCodeAt(result.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
}

function latestSections(sections: readonly TranscriptSection[]): readonly TranscriptSection[] {
  return sections.slice(-historyPreviewSectionCount);
}

function parseEntry(text: string): Result<FileEntry, HistoryError> {
  const parsed = parseJson(text, "saved conversation preview");
  if (!parsed.ok)
    return err(new HistoryError("HISTORY_CORRUPT", parsed.error.message, { cause: parsed.error }));
  if (!object(parsed.value) || typeof parsed.value.type !== "string")
    return corrupt("Invalid saved conversation entry.");
  const entry = parseSessionEntries(text)[0];
  return entry ? ok(entry) : corrupt("Invalid saved conversation entry.");
}

// A prefix is only an identity hint for skipping unrelated branches. Selected records are fully validated.
// Scan complete root properties when the identity precedes the payload; otherwise fall back to validation.
function prefixId(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  let depth = 0,
    quoted = false,
    escaped = false,
    end = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        end = index;
        break;
      }
    } else if (char === "," && depth === 1) end = index;
  }
  if (end < 0) return undefined;
  const parsed = parseJson(text.slice(0, end) + "}", "history identity prefix");
  return parsed.ok && object(parsed.value) && typeof parsed.value.id === "string"
    ? parsed.value.id
    : undefined;
}

function project(
  header: SessionHeader,
  newestFirst: readonly SessionEntry[],
): readonly TranscriptSection[] {
  // Migrations mutate only these in-memory copies, never a saved file or an SDK writer.
  const entries: FileEntry[] = [
    { ...header },
    ...newestFirst.toReversed().map((entry) => ({ ...entry })),
  ];
  migrateSessionEntries(entries);
  return latestSections(
    new SessionTranscript(entries.filter((entry) => entry.type !== "session")).sections,
  );
}
function resolvedTools(
  sections: readonly TranscriptSection[],
  entries: readonly SessionEntry[],
): boolean {
  const calls = new Set<string>();
  for (const entry of entries)
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const part of entry.message.content) if (part.type === "toolCall") calls.add(part.id);
    }
  return sections.every(
    (section) => section.kind !== "tool" || !section.toolCallId || calls.has(section.toolCallId),
  );
}

// Snapshot the descriptor, verify its header, then walk the append-only branch backwards.
// There is no whole-file size limit: old turns need not be decoded or retained at all.
export async function readHistoryPreview(
  path: string,
  worktreeId: string,
  id: string,
  signal?: AbortSignal,
  scope?: { readonly cwd: string; readonly requireCwd: boolean },
): Promise<Result<HistoryPreview, ExpectedError>> {
  if (signal?.aborted) return err(new CancelledError());
  const deadline = Date.now() + 5000;
  const read = await capture(async () => {
    const file = await open(path, "r");
    return withCleanup(
      async (): Promise<Result<HistoryPreview, ExpectedError>> => {
        const size = (await file.stat()).size;
        if (!size) return corrupt("Saved conversation has no session header.");
        const prefix = await readHistoryBytes(
          file,
          0,
          Math.min(size, historyReadChunk),
          signal,
          deadline,
        );
        if (!prefix.ok) return prefix;
        const lines = prefix.value.toString("utf8").split("\n");
        let headerStart = 0,
          headerEnd = 0,
          headerText: string | undefined;
        for (const [index, line] of lines.entries()) {
          if (line.trim()) {
            if (index === lines.length - 1 && size > prefix.value.length)
              return err(
                new HistoryError(
                  "HISTORY_UNAVAILABLE",
                  "Saved session header exceeds the 64 KiB safety limit.",
                ),
              );
            headerText = line.trim();
            headerEnd = headerStart + Buffer.byteLength(line) + 1;
            break;
          }
          headerStart += Buffer.byteLength(line) + 1;
        }
        if (!headerText) return corrupt("Saved conversation has no session header.");
        const parsedHeader = parseEntry(headerText);
        if (!parsedHeader.ok) return parsedHeader;
        const header = parsedHeader.value;
        if (header.type !== "session" || header.id !== id)
          return corrupt("Saved conversation identity changed; refresh history.");
        // Discovery metadata is only a lookup hint. Recheck the selected file's current worktree binding.
        if (scope) {
          if (
            header.cwd !== undefined &&
            (typeof header.cwd !== "string" || header.cwd.includes("\0"))
          )
            return corrupt("Saved conversation has an invalid worktree.");
          if (header.cwd) {
            const cwd = await capture(() => realpath(header.cwd));
            if (!cwd.ok) return cwd;
            if (cwd.value !== scope.cwd)
              return err(
                new HistoryError(
                  "HISTORY_UNAVAILABLE",
                  "Saved conversation belongs to a different worktree. Refresh history.",
                ),
              );
          } else if (scope.requireCwd)
            return err(
              new HistoryError(
                "HISTORY_UNAVAILABLE",
                "Saved conversation has no worktree identity. Refresh history.",
              ),
            );
        }
        if (
          header.version !== undefined &&
          (!Number.isInteger(header.version) ||
            header.version < 1 ||
            header.version > CURRENT_SESSION_VERSION)
        ) {
          return err(
            new HistoryError(
              "HISTORY_UNAVAILABLE",
              "Saved conversation version is not supported by preview.",
            ),
          );
        }
        const legacy = header.version === undefined || header.version < 2;
        const retained: SessionEntry[] = [],
          seen = new Set<string>();
        let parent: string | null | undefined,
          retainedBytes = 0;
        let recent: readonly TranscriptSection[] = [];
        // A completed turn boundary is safe to return if older records exceed the preview budget.
        let boundedRecent: readonly TranscriptSection[] = [];
        for await (const line of reverseHistoryLines(file, size, signal, deadline)) {
          if (!line.ok) return line;
          const failure = historyReadFailure(signal, deadline);
          if (failure) return err(failure);
          const length = line.value.end - line.value.start;
          if (!legacy && parent !== undefined && line.value.start !== headerStart) {
            const hint = await readHistoryBytes(
              file,
              line.value.start,
              Math.min(length, historyReadChunk),
              signal,
              deadline,
            );
            if (!hint.ok) return hint;
            const candidate = prefixId(hint.value);
            if (candidate !== undefined && candidate !== parent) continue;
          }
          if (length > recordLimit)
            return boundedRecent.length
              ? ok(previewResult(worktreeId, id, boundedRecent, retained, true))
              : err(
                  new HistoryError(
                    "HISTORY_UNAVAILABLE",
                    "A saved history record exceeds the 16 MiB per-record preview safety limit.",
                  ),
                );
          const bytes = await readHistoryBytes(file, line.value.start, length, signal, deadline);
          if (!bytes.ok) return bytes;
          const text = bytes.value.toString("utf8").trim();
          if (!text) continue;
          const parsed = parseEntry(text);
          if (!parsed.ok) return parsed;
          const entry = parsed.value;
          if (entry.type === "session") {
            if (line.value.start !== headerStart)
              return corrupt("Saved conversation has more than one session header.");
            if (!legacy && parent !== undefined && parent !== null)
              return corrupt("Saved conversation branch is incomplete.");
            return ok(previewResult(worktreeId, id, recent, retained));
          }
          if (!legacy) {
            if (
              typeof entry.id !== "string" ||
              !entry.id ||
              entry.id.length > 4096 ||
              (entry.parentId !== null && typeof entry.parentId !== "string")
            )
              return corrupt("Invalid saved conversation branch.");
            if (parent !== undefined && entry.id !== parent) continue;
            if (
              seen.has(entry.id) ||
              (entry.parentId !== null && seen.has(entry.parentId)) ||
              entry.parentId === entry.id
            )
              return corrupt("Saved conversation branch contains a cycle.");
            if (line.value.start === headerEnd && entry.parentId !== null)
              return corrupt("Saved conversation branch is incomplete.");
            seen.add(entry.id);
            parent = entry.parentId;
          }
          if (
            [
              "message",
              "custom_message",
              "compaction",
              "branch_summary",
              "model_change",
              "thinking_level_change",
            ].includes(entry.type) ||
            (entry.type === "custom" && entry.customType === runCompletionEntryType)
          ) {
            const valid = validateEntry(entry);
            if (!valid.ok) return valid;
            retainedBytes += length;
            if (retainedBytes > retainedLimit)
              return boundedRecent.length
                ? ok(previewResult(worktreeId, id, boundedRecent, retained, true))
                : err(
                    new HistoryError(
                      "HISTORY_UNAVAILABLE",
                      "Recent tool association exceeds the 32 MiB working-set safety limit.",
                    ),
                  );
            retained.push(entry);
            recent = project(header, retained);
            const stopped = historyReadFailure(signal, deadline);
            if (stopped) return err(stopped);
            const prompt = entry.type === "message" && entry.message.role === "user";
            if (prompt) boundedRecent = recent;
            // Resolve tool calls before cutting the tail; orphan results are safe at a prompt boundary.
            if (
              recent.length >= historyPreviewSectionCount &&
              (prompt || resolvedTools(recent, retained))
            )
              return ok(previewResult(worktreeId, id, recent, retained));
          }
          if (!legacy && parent === null)
            return ok(previewResult(worktreeId, id, recent, retained));
        }
        return corrupt("Saved conversation branch is incomplete.");
      },
      () => file.close(),
    );
  });
  return read.ok ? read.value : read;
}

export function previewSessionSnapshot(record: SessionRecord, id: string): HistoryPreview {
  const bounded = previewResult(
    record.worktreeId,
    id,
    record.state.sections?.slice(-historyPreviewSectionCount) ?? [],
    [],
  );
  const { sections, telemetry: _telemetry, ...preview } = bounded;
  const output = clip(record.state.output, historyPreviewLimit);
  const state = {
    ...record.state,
    output,
    ...(record.state.sections !== undefined ? { sections: sections! } : {}),
  };
  return {
    ...preview,
    text: record.state.sections === undefined ? output : preview.text,
    truncated: preview.truncated || output !== record.state.output,
    ...(record.state.sections !== undefined ? { sections: sections! } : {}),
    ...(record.state.telemetry ? { telemetry: record.state.telemetry } : {}),
    snapshot: { ...record, state },
  };
}

function previewResult(
  worktreeId: string,
  id: string,
  recent: readonly TranscriptSection[],
  newestFirst: readonly SessionEntry[],
  truncated = false,
): HistoryPreview {
  const sections = recent.map((section): TranscriptSection => {
    const text = clip(section.text, historyPreviewSectionLimit),
      title = clip(section.title, 256);
    const summary = section.summary === undefined ? undefined : clip(section.summary, 512);
    const error = section.error === undefined ? undefined : clip(section.error, 512);
    const skillName = section.skillName === undefined ? undefined : clip(section.skillName, 256);
    truncated ||=
      text !== section.text ||
      title !== section.title ||
      summary !== section.summary ||
      error !== section.error ||
      skillName !== section.skillName;
    return {
      ...section,
      text,
      title,
      ...(summary !== undefined ? { summary } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(skillName !== undefined ? { skillName } : {}),
    };
  });
  // Keep the original bounded text field for clients predating structured previews.
  const preview = clip(
    sections
      .filter(
        (section) =>
          section.kind === "user" ||
          section.kind === "assistant" ||
          section.skillName !== undefined,
      )
      .map((section) => `${section.title}\n${section.text}`)
      .join("\n\n"),
    historyPreviewLimit,
  );
  // Saved files can identify a model/effort, but cannot authorize current account usage or Fast state.
  let provider: string | null = null,
    model: string | null = null,
    effort: string | null = null;
  for (const entry of newestFirst) {
    if (entry.type === "thinking_level_change" && effort === null)
      effort = clip(entry.thinkingLevel, 256);
    if (model !== null) continue;
    if (entry.type === "model_change") {
      provider = clip(entry.provider, 256);
      model = clip(entry.modelId, 256);
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      typeof entry.message.model === "string" &&
      typeof entry.message.provider === "string"
    ) {
      provider = clip(entry.message.provider, 256);
      model = clip(entry.message.model, 256);
    }
  }
  const telemetry: SessionTelemetry = {
    provider,
    model,
    effort,
    fast: null,
    context: null,
    weekly: null,
  };
  return { id, worktreeId, text: preview, sections, truncated, telemetry };
}
