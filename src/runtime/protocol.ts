import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Repository } from "../workspace/model.ts";
import type { SessionRecord } from "../sessions/session-registry.ts";
import { errorCodes, ExpectedError, InputError, parseJson, ProtocolError, type ErrorCode } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const protocolVersion = 1;
export const maxFrameBytes = 8 * 1024 * 1024;
const id = Type.String({ minLength: 1, maxLength: 4096 });
const status = Type.Union([Type.Literal("working"), Type.Literal("complete"), Type.Literal("failure"), Type.Null()]);
const agent = Type.Object({ id, name: Type.String(), status });
const session = Type.Object({ id, name: Type.String(), status, subagents: Type.Array(agent) });
const worktree = Type.Object({ id, path: id, name: Type.String(), branch: Type.Union([Type.String(), Type.Null()]), sessions: Type.Array(session) });
const repository = Type.Object({ id, name: Type.String(), worktrees: Type.Array(worktree) });
const execution = Type.Object({ status, output: Type.String(), error: Type.Union([Type.String(), Type.Null()]) });
export const preferencesSchema = Type.Object({
  selection: Type.Object({ worktreeId: Type.Union([id, Type.Null()]), sessions: Type.Record(Type.String(), Type.String()) }),
  drafts: Type.Record(Type.String(), Type.String({ maxLength: 1000000 })),
});
export type RuntimePreferences = Static<typeof preferencesSchema>;
export const emptyPreferences: RuntimePreferences = { selection: { worktreeId: null, sessions: {} }, drafts: {} };
export const snapshotSchema = Type.Object({
  version: Type.Literal(protocolVersion), pid: Type.Integer({ minimum: 1 }), instance: id,
  capabilities: Type.Optional(Type.Array(Type.String())),
  mode: Type.Union([Type.Literal("live"), Type.Literal("offline")]), repositoryId: id,
  repositories: Type.Array(repository), details: Type.Record(Type.String(), execution),
  closingCount: Type.Integer({ minimum: 0 }), preferences: preferencesSchema, notice: Type.String(),
});
export type RuntimeSnapshot = Omit<Static<typeof snapshotSchema>, "repositories"> & { readonly repositories: readonly Repository[] };
const record = Type.Object({
  id, name: Type.String(), worktreeId: id, sessionFile: Type.Optional(id),
  state: execution, subagents: Type.Array(agent),
});
export const manifestSchema = Type.Object({
  version: Type.Literal(protocolVersion), repositoryId: id,
  repositories: Type.Array(repository), records: Type.Array(record), preferences: preferencesSchema,
});
export type RuntimeManifest = Omit<Static<typeof manifestSchema>, "repositories" | "records"> & {
  readonly repositories: readonly Repository[];
  readonly records: readonly SessionRecord[];
};
export const historySchema = Type.Array(Type.Object({ id, worktreeId: id, title: Type.String(), modified: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }), openSessionId: Type.Union([id, Type.Null()]), unavailableReason: Type.Union([Type.String(), Type.Null()]),
}));
export const commandSchema = Type.Union([
  Type.Object({ type: Type.Literal("create"), worktreeId: id }),
  Type.Object({ type: Type.Literal("resume"), worktreeId: id, savedId: id }),
  Type.Object({ type: Type.Literal("close"), sessionId: id }),
  Type.Object({ type: Type.Literal("prompt"), sessionId: id, text: Type.String({ minLength: 1, maxLength: 1000000 }) }),
  Type.Object({ type: Type.Literal("preferences"), preferences: preferencesSchema }),
  Type.Object({ type: Type.Literal("stop") }),
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
export function wireError(error: ExpectedError, outcome: WireError["outcome"] = "rejected"): WireError {
  return { code: error.code, message: error.message, outcome };
}
export function errorStatus(error: ExpectedError): number {
  switch (error.code) {
    case "INVALID_INPUT": return 400;
    case "SESSION_NOT_OPEN": case "HISTORY_UNAVAILABLE": return 404;
    case "SESSION_BUSY": case "SESSION_CONFLICT": case "CANCELLED": return 409;
    case "RUNTIME_STOPPING": case "RUNTIME_ABSENT": case "CONNECTION_FAILED": case "CONNECTION_TIMEOUT": return 503;
    case "UNSUPPORTED_CAPABILITY": case "PROTOCOL_ERROR": return 422;
    default: return 500;
  }
}
export function parseCommand(text: string): Result<RuntimeCommand, InputError> {
  const parsed = parseJson(text, "command"); if (!parsed.ok) return parsed;
  return Value.Check(commandSchema, parsed.value) ? ok(parsed.value) : err(new InputError("Malformed runtime command."));
}
export function parseSnapshot(value: unknown): Result<RuntimeSnapshot, ProtocolError> {
  return Value.Check(snapshotSchema, value) ? ok(value) : err(new ProtocolError("Incompatible or malformed runtime snapshot."));
}
