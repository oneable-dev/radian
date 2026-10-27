import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import type { ExecutionState, SessionRecord } from "../agents/session-registry.ts";
import type { GitViewState } from "../git/model.ts";
import { gitViewsSchema } from "../git/preferences.ts";
import { agentViewsSchema, type TranscriptViewState } from "../agents/transcript-preferences.ts";
import { runCompletionSchema } from "../agents/run-completion.ts";
import { requestSummarySchema } from "../agents/request-summary.ts";
import { transcriptImageSchema } from "../agents/transcript-images.ts";
import { promptDraftSchema, validatePromptDraft } from "../agents/prompt-input.ts";
import { errorCodes, usageErrorCodes, AgentRunError, ExpectedError, InputError, parseJson, ProtocolError, type ErrorCode, type UsageErrorCode } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { modelEffortSchema, modelIdentitySchema } from "../agents/model-selection.ts";
import { sessionResultSchema } from "../agents/session-attention.ts";
import { extensionUiResponseSchema, sessionExtensionUiSchema } from "../agents/extension-ui.ts";

export const protocolVersion = 1;
// Commands and PTY frames describe one operation/viewport. A workspace snapshot
// aggregates every retained session and must not inherit that per-operation limit.
export const maxFrameBytes = 8 * 1024 * 1024;
export const maxSnapshotBytes = 64 * 1024 * 1024;
const id = Type.String({ minLength: 1, maxLength: 4096 });
const status = Type.Union([Type.Literal("working"), Type.Literal("complete"), Type.Literal("failure"), Type.Null()]);
const runTiming = Type.Object({ startedAt: Type.Integer({ minimum: 0 }), elapsedMs: Type.Number({ minimum: 0 }) });
const agent = Type.Object({ id, name: Type.String(), status, request: Type.Optional(requestSummarySchema),
  runTiming: Type.Optional(runTiming), source: Type.Optional(Type.Literal("pi")),
  phase: Type.Optional(Type.Union([Type.Literal("queued"), Type.Literal("paused"), Type.Literal("stopped"), Type.Literal("rejected"), Type.Literal("partial")])) });
const session = Type.Object({ id, name: Type.String(), status, subagents: Type.Array(agent),
  request: Type.Optional(requestSummarySchema), result: Type.Optional(sessionResultSchema), attention: Type.Optional(sessionResultSchema) });
const worktree = Type.Object({ id, path: id, name: Type.String(), branch: Type.Union([Type.String(), Type.Null()]), sessions: Type.Array(session) });
const repository = Type.Object({ id, name: Type.String(), worktrees: Type.Array(worktree) });
const transcriptSection = Type.Object({
  id, kind: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("thinking"), Type.Literal("tool"), Type.Literal("notice")]),
  title: Type.String(), text: Type.String(),
  status: Type.Union([Type.Literal("complete"), Type.Literal("streaming"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("error"), Type.Literal("cancelled"), Type.Literal("unfinished")]),
  summary: Type.Optional(Type.String()), error: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()),
  completion: Type.Optional(runCompletionSchema), request: Type.Optional(requestSummarySchema), image: Type.Optional(transcriptImageSchema),
  skillName: Type.Optional(Type.String({ minLength: 1 })), command: Type.Optional(Type.String({ maxLength: 4096 })), timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});
const nullableText = Type.Union([Type.String(), Type.Null()]);
const usage = Type.Object({
  provider: Type.String(), status: Type.Union([Type.Literal("loading"), Type.Literal("ready"), Type.Literal("unavailable"), Type.Literal("error")]),
  windows: Type.Array(Type.Object({ id: Type.String(), usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
    periodMs: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
    resetsAt: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]) })),
  updatedAt: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  errorCode: Type.Union([Type.Unsafe<UsageErrorCode>({ type: "string", enum: [...usageErrorCodes] }), Type.Null()]),
});
const telemetry = Type.Object({
  provider: nullableText, model: nullableText, effort: nullableText, fast: Type.Union([Type.Boolean(), Type.Null()]),
  usage: Type.Optional(usage),
  context: Type.Union([Type.Object({ usedTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    maxTokens: Type.Number({ exclusiveMinimum: 0 }) }), Type.Null()]),
  weekly: Type.Union([Type.Object({ remainingPercent: Type.Number({ minimum: 0, maximum: 100 }),
    resetsAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    observedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }), Type.Null()]),
});
const execution = Type.Object({ conversationId: Type.Optional(id), resourceRevision: Type.Optional(Type.Integer({ minimum: 0 })), status, activity: Type.Optional(Type.Literal("compacting")), output: Type.String(), error: Type.Union([Type.String(), Type.Null()]),
  sections: Type.Optional(Type.Array(transcriptSection)), telemetry: Type.Optional(telemetry),
  request: Type.Optional(requestSummarySchema), result: Type.Optional(sessionResultSchema), attention: Type.Optional(sessionResultSchema),
  externalSubagents: Type.Optional(Type.Array(agent)),
  pendingMessages: Type.Optional(Type.Array(requestSummarySchema)), runTiming: Type.Optional(runTiming) });
export const workViewSchema = Type.Union([Type.Literal("agent"), Type.Literal("editor"), Type.Literal("git"), Type.Literal("terminal")]);
export type WorkView = Static<typeof workViewSchema>;
// Preserve the original three-view wire enum for existing clients/manifests.
export const workViewsSchema = Type.Object({
  active: Type.Record(Type.String(), Type.Union([Type.Literal("agent"), Type.Literal("editor"), Type.Literal("git")])),
  agentScroll: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type WorkViewPreferences = { active: Record<string, WorkView>; agentScroll: Record<string, number>; terminalSelection?: Record<string, string>; gitViews?: Record<string, GitViewState>; agentViews?: Record<string, TranscriptViewState> };
export const ptyInfoSchema = Type.Object({
  id, worktreeId: id, pid: Type.Integer({ minimum: 1 }), exited: Type.Boolean(), exitCode: Type.Union([Type.Integer(), Type.Null()]),
});
export type PtyInfo = Static<typeof ptyInfoSchema>;
export const terminalInfoSchema = Type.Object({ ...ptyInfoSchema.properties, title: Type.String(), shellPid: Type.Integer({ minimum: 2 }) });
export type TerminalInfo = Static<typeof terminalInfoSchema>;
export const editorInfoSchema = ptyInfoSchema;
export type EditorInfo = PtyInfo;
export const terminalLinkSchema = Type.Object({ url: Type.String(), cells: Type.Array(Type.Object({
  row: Type.Integer({ minimum: 0, maximum: 199 }),
  start: Type.Integer({ minimum: 0, maximum: 499 }), end: Type.Integer({ minimum: 1, maximum: 500 }),
})) });
export type TerminalLink = Static<typeof terminalLinkSchema>;
export const ptyFrameSchema = Type.Object({ ...ptyInfoSchema.properties,
  cols: Type.Integer({ minimum: 2, maximum: 500 }), rows: Type.Integer({ minimum: 1, maximum: 200 }),
  revision: Type.Integer({ minimum: 0 }), ansi: Type.String({ maxLength: maxFrameBytes }),
  links: Type.Optional(Type.Array(terminalLinkSchema)),
  scrollback: Type.Optional(Type.Object({ offset: Type.Integer({ minimum: 0 }), available: Type.Integer({ minimum: 0 }), enabled: Type.Boolean() })),
});
export type PtyFrame = Static<typeof ptyFrameSchema>;
export const terminalTextSchema = Type.Object({ text: Type.String({ maxLength: maxFrameBytes / 2 }),
  cursor: Type.Object({ row: Type.Integer({ minimum: 0 }), column: Type.Integer({ minimum: 0 }) }) });
export type TerminalText = Static<typeof terminalTextSchema>;
export const editorFrameSchema = ptyFrameSchema;
export type EditorFrame = PtyFrame;
export const preferencesSchema = Type.Object({
  selection: Type.Object({ worktreeId: Type.Union([id, Type.Null()]), sessions: Type.Record(Type.String(), Type.String()) }),
  drafts: Type.Record(Type.String(), Type.String()),
  inputDrafts: Type.Optional(Type.Record(Type.String(), promptDraftSchema)),
  workViews: Type.Optional(workViewsSchema),
  gitViews: Type.Optional(gitViewsSchema),
  agentViews: Type.Optional(agentViewsSchema),
  terminalViews: Type.Optional(Type.Object({ active: Type.Array(id), selected: Type.Record(Type.String(), id) })),
});
export type RuntimePreferences = Static<typeof preferencesSchema>;
export const emptyPreferences: RuntimePreferences = { selection: { worktreeId: null, sessions: {} }, drafts: {} };
export const snapshotSchema = Type.Object({
  version: Type.Literal(protocolVersion), pid: Type.Integer({ minimum: 1 }), instance: id,
  capabilities: Type.Optional(Type.Array(Type.String())),
  mode: Type.Union([Type.Literal("live"), Type.Literal("offline")]), repositoryId: id,
  repositories: Type.Array(repository), details: Type.Record(Type.String(), execution),
  closingCount: Type.Integer({ minimum: 0 }), preferences: preferencesSchema, notice: Type.String(),
  accountsRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  historyRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  extensionUi: Type.Optional(Type.Array(sessionExtensionUiSchema)),
  editors: Type.Optional(Type.Array(editorInfoSchema)),
  terminals: Type.Optional(Type.Array(terminalInfoSchema)),
  terminalClosingCount: Type.Optional(Type.Integer({ minimum: 0 })),
  sessionRetention: Type.Optional(Type.Object({ retentionDays: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    lastSweepAt: Type.Integer({ minimum: 0, maximum: 8640000000000000 }), removed: Type.Integer({ minimum: 0 }) })),
});
export type RuntimeSnapshot = Omit<Static<typeof snapshotSchema>, "repositories" | "details"> & { readonly repositories: readonly Repository[]; readonly details: Readonly<Record<string, ExecutionState>> };
export const sessionRecordSchema = Type.Object({
  id, name: Type.String(), worktreeId: id, sessionFile: Type.Optional(id),
  state: execution, subagents: Type.Array(agent),
  lifecycle: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
  closedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 8640000000000000 }), Type.Null()])), managed: Type.Optional(Type.Boolean()),
  updatedAt: Type.Optional(Type.Integer({ minimum: 0, maximum: 8640000000000000 })), cwd: Type.Optional(id),
});
export const manifestSchema = Type.Object({
  version: Type.Literal(protocolVersion), repositoryId: id,
  repositories: Type.Array(repository), records: Type.Array(sessionRecordSchema), preferences: preferencesSchema,
});
export type RuntimeManifest = Omit<Static<typeof manifestSchema>, "repositories" | "records"> & {
  readonly repositories: readonly Repository[];
  readonly records: readonly SessionRecord[];
};
export const historySchema = Type.Array(Type.Object({ id, worktreeId: id, title: Type.String(), modified: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }), revision: Type.Optional(Type.String()), openSessionId: Type.Union([id, Type.Null()]), unavailableReason: Type.Union([Type.String(), Type.Null()]),
}));
export const historyPreviewSchema = Type.Object({ id, worktreeId: id, text: Type.String({ maxLength: 65536 }), truncated: Type.Boolean(),
  sections: Type.Optional(Type.Array(Type.Object({ ...transcriptSection.properties, text: Type.String({ maxLength: 8192 }) }), { maxItems: 15 })),
  telemetry: Type.Optional(telemetry),
  snapshot: Type.Optional(Type.Object({ ...sessionRecordSchema.properties, state: Type.Object({ ...execution.properties,
    output: Type.String({ maxLength: 65536 }), sections: Type.Optional(Type.Array(Type.Object({ ...transcriptSection.properties, text: Type.String({ maxLength: 8192 }) }), { maxItems: 15 })),
  }) })),
});
export const historyPreviewQuerySchema = Type.Object({ worktreeId: id, savedId: id }, { additionalProperties: false });
const size = { cols: Type.Integer({ minimum: 2, maximum: 500 }), rows: Type.Integer({ minimum: 1, maximum: 200 }) };
const inputBytes = Type.String({ maxLength: 131072, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" });
export const commandSchema = Type.Union([
  Type.Object({ type: Type.Literal("terminal-create"), worktreeId: id, ...size }),
  Type.Object({ type: Type.Literal("terminal-close"), terminalId: id }),
  Type.Object({ type: Type.Literal("terminal-detach"), terminalId: id, lease: id }),
  Type.Object({ type: Type.Literal("terminal-input"), terminalId: id, lease: id, data: inputBytes }),
  Type.Object({ type: Type.Literal("terminal-resize"), terminalId: id, lease: id, ...size }),
  Type.Object({ type: Type.Literal("terminal-scroll"), terminalId: id, lease: id, lines: Type.Integer({ minimum: -10000, maximum: 10000 }) }),
  Type.Object({ type: Type.Literal("terminal-read"), terminalId: id, lease: id }),
  Type.Object({ type: Type.Literal("create"), worktreeId: id }),
  Type.Object({ type: Type.Literal("resume"), worktreeId: id, savedId: id }),
  Type.Object({ type: Type.Literal("close"), sessionId: id }),
  Type.Object({ type: Type.Literal("extension-ui-response"), sessionId: id, conversationId: id, response: extensionUiResponseSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("interrupt"), sessionId: id, conversationId: id }),
  Type.Object({ type: Type.Literal("acknowledge"), sessionId: id, conversationId: id, resultId: id }),
  Type.Object({ type: Type.Literal("model-select"), sessionId: id, conversationId: id, model: modelIdentitySchema, effort: Type.Optional(modelEffortSchema) }),
  Type.Object({ type: Type.Literal("prompt"), sessionId: id, text: Type.String({ minLength: 1 }), images: Type.Optional(Type.Array(id)), conversationId: Type.Optional(id), resourceRevision: Type.Optional(Type.Integer({ minimum: 0 })) }),
  Type.Object({ type: Type.Literal("session-control"), sessionId: id, conversationId: id,
    // Preserve legacy wire "new" as replacement; new clients use explicit tab/clear actions.
    action: Type.Union([Type.Literal("new"), Type.Literal("new-tab"), Type.Literal("clear"), Type.Literal("exit"), Type.Literal("compact"), Type.Literal("reload")]), instructions: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("preferences"), preferences: preferencesSchema }),
  Type.Object({ type: Type.Literal("stop") }),
  Type.Object({ type: Type.Literal("editor-open"), worktreeId: id,
    cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })), rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
  Type.Object({ type: Type.Literal("editor-detach"), editorId: id, lease: id }),
  Type.Object({ type: Type.Literal("editor-input"), editorId: id, lease: id, data: inputBytes }),
  Type.Object({ type: Type.Literal("editor-resize"), editorId: id, lease: id,
    cols: Type.Integer({ minimum: 2, maximum: 500 }), rows: Type.Integer({ minimum: 1, maximum: 200 }) }),
]);
export type RuntimeCommand = Static<typeof commandSchema>;
export const wireErrorSchema = Type.Object({
  // JSON enum and TypeScript union share one source; Type.Union(map()) loses tuple inference.
  code: Type.Unsafe<ErrorCode>({ type: "string", enum: [...errorCodes] }), message: Type.String(),
  outcome: Type.Union([Type.Literal("rejected"), Type.Literal("unknown")]),
});
export type WireError = { code: ErrorCode; message: string; outcome: "rejected" | "unknown" };
export const replySchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), value: Type.Union([Type.String(), Type.Null()]), warnings: Type.Optional(Type.Array(wireErrorSchema)) }),
  Type.Object({ ok: Type.Literal(false), error: Type.Union([Type.String(), wireErrorSchema]) }),
]);
export function wireError(error: ExpectedError, outcome: WireError["outcome"] = error instanceof AgentRunError ? "unknown" : "rejected"): WireError {
  return { code: error.code, message: error.message, outcome };
}
export function errorStatus(error: ExpectedError): number {
  switch (error.code) {
    case "INVALID_INPUT": return 400;
    case "ACCOUNT_NOT_FOUND": case "SESSION_NOT_OPEN": case "HISTORY_UNAVAILABLE": case "EDITOR_NOT_OPEN": case "PTY_NOT_OPEN": return 404;
    case "ACCOUNT_IN_USE": case "ACCOUNT_CONFLICT": case "SESSION_BUSY": case "SESSION_CONFLICT": case "CANCELLED": case "EDITOR_BUSY": case "PTY_BUSY": return 409;
    case "RUNTIME_STOPPING": case "RUNTIME_ABSENT": case "CONNECTION_FAILED": case "CONNECTION_TIMEOUT": return 503;
    case "ACCOUNT_LOGIN_FAILED": case "BROWSER_UNAVAILABLE": case "UNSUPPORTED_CAPABILITY": case "MODEL_UNAVAILABLE": case "PROTOCOL_ERROR": case "EDITOR_UNAVAILABLE": case "PTY_UNAVAILABLE": return 422;
    default: return 500;
  }
}
export function parseCommand(text: string): Result<RuntimeCommand, InputError> {
  const parsed = parseJson(text, "command"); if (!parsed.ok) return parsed;
  if (!Value.Check(commandSchema, parsed.value)) return err(new InputError("Malformed runtime command."));
  if (parsed.value.type === "prompt" && parsed.value.images?.some((path) => path.includes("\0"))) return err(new InputError("Image paths must not contain NUL bytes."));
  if (parsed.value.type === "preferences" && parsed.value.preferences.inputDrafts) {
    for (const draft of Object.values(parsed.value.preferences.inputDrafts)) { const valid = validatePromptDraft(draft); if (!valid.ok) return valid; }
  }
  return ok(parsed.value);
}
export function parseSnapshot(value: unknown): Result<RuntimeSnapshot, ProtocolError> {
  if (!Value.Check(snapshotSchema, value)) return err(new ProtocolError("Incompatible or malformed runtime snapshot."));
  for (const draft of Object.values(value.preferences.inputDrafts ?? {})) {
    const valid = validatePromptDraft(draft); if (!valid.ok) return err(new ProtocolError(valid.error.message, { cause: valid.error }));
  }
  return ok(value);
}
