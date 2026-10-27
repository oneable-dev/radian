import { err, ok, type Result } from "./result.ts";

export const usageErrorCodes = ["USAGE_AUTH_REQUIRED", "USAGE_QUERY_FAILED", "USAGE_PROTOCOL_ERROR", "USAGE_RATE_LIMITED", "USAGE_TIMEOUT"] as const;
export const errorCodes = [
  "INVALID_INPUT", "SESSION_NOT_OPEN", "SESSION_BUSY", "SESSION_CONFLICT", "RUNTIME_STOPPING",
  "ACCOUNT_NOT_FOUND", "ACCOUNT_IN_USE", "ACCOUNT_CONFLICT", "ACCOUNT_LOGIN_FAILED", "BROWSER_UNAVAILABLE",
  "CANCELLED", "AGENT_FAILED", "CLEANUP_FAILED", "HISTORY_UNAVAILABLE", "HISTORY_CORRUPT", "MODEL_UNAVAILABLE",
  "STORAGE_FAILED", "RUNTIME_ABSENT", "CONNECTION_FAILED", "CONNECTION_TIMEOUT", "PROTOCOL_ERROR",
  "UNSUPPORTED_CAPABILITY", "LEGACY_REMOTE_ERROR", "REMOTE_INTERNAL_ERROR", "GIT_DISCOVERY_FAILED",
  ...usageErrorCodes,
  "GIT_QUERY_FAILED", "GIT_PREVIEW_UNAVAILABLE", "GIT_PROTOCOL_ERROR", "CLIPBOARD_UNAVAILABLE",
  "EDITOR_UNAVAILABLE", "EDITOR_NOT_OPEN", "EDITOR_BUSY", "PTY_NOT_OPEN", "PTY_BUSY", "PTY_UNAVAILABLE", "PTY_OWNERSHIP_LOST", "PTY_CLEANUP_FAILED",
] as const;
export type ErrorCode = typeof errorCodes[number];

export class ExpectedError<C extends ErrorCode = ErrorCode> extends Error {
  constructor(readonly code: C, message: string, options?: ErrorOptions) {
    super(message, options); this.name = new.target.name;
  }
}
export class InputError extends ExpectedError<"INVALID_INPUT"> {
  constructor(message: string, options?: ErrorOptions) { super("INVALID_INPUT", message, options); }
}
export class SessionError extends ExpectedError<"SESSION_NOT_OPEN" | "SESSION_BUSY" | "SESSION_CONFLICT" | "RUNTIME_STOPPING"> {
  constructor(code: "SESSION_NOT_OPEN" | "SESSION_BUSY" | "SESSION_CONFLICT" | "RUNTIME_STOPPING", message: string) { super(code, message); }
}
export class CancelledError extends ExpectedError<"CANCELLED"> {
  constructor(message = "Operation was cancelled.", options?: ErrorOptions) { super("CANCELLED", message, options); }
}
export class AccountError extends ExpectedError<"ACCOUNT_NOT_FOUND" | "ACCOUNT_IN_USE" | "ACCOUNT_CONFLICT" | "ACCOUNT_LOGIN_FAILED"> {
  constructor(code: "ACCOUNT_NOT_FOUND" | "ACCOUNT_IN_USE" | "ACCOUNT_CONFLICT" | "ACCOUNT_LOGIN_FAILED", message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class BrowserError extends ExpectedError<"BROWSER_UNAVAILABLE"> {
  constructor(message: string, options?: ErrorOptions) { super("BROWSER_UNAVAILABLE", message, options); }
}
export class ModelSelectionError extends ExpectedError<"MODEL_UNAVAILABLE"> {
  constructor(message: string, options?: ErrorOptions) { super("MODEL_UNAVAILABLE", message, options); }
}
export class AgentRunError extends ExpectedError<"AGENT_FAILED"> {
  constructor(message: string, options?: ErrorOptions) { super("AGENT_FAILED", message, options); }
}
export class CleanupError extends ExpectedError<"CLEANUP_FAILED"> {
  constructor(message: string, readonly errors: readonly ExpectedError[]) { super("CLEANUP_FAILED", message, { cause: new AggregateError(errors) }); }
}
export class HistoryError extends ExpectedError<"HISTORY_UNAVAILABLE" | "HISTORY_CORRUPT"> {
  constructor(code: "HISTORY_UNAVAILABLE" | "HISTORY_CORRUPT", message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class StorageError extends ExpectedError<"STORAGE_FAILED"> {
  constructor(message: string, readonly systemCode?: string, options?: ErrorOptions) { super("STORAGE_FAILED", message, options); }
}
export class ConnectionError extends ExpectedError<"RUNTIME_ABSENT" | "CONNECTION_FAILED" | "CONNECTION_TIMEOUT"> {
  constructor(code: "RUNTIME_ABSENT" | "CONNECTION_FAILED" | "CONNECTION_TIMEOUT", message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class ProtocolError extends ExpectedError<"PROTOCOL_ERROR"> {
  constructor(message: string, options?: ErrorOptions) { super("PROTOCOL_ERROR", message, options); }
}
type PtyErrorCode = "PTY_NOT_OPEN" | "PTY_BUSY" | "PTY_UNAVAILABLE" | "PTY_OWNERSHIP_LOST" | "PTY_CLEANUP_FAILED";
export class PtyError extends ExpectedError<PtyErrorCode> {
  constructor(code: PtyErrorCode, message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class EditorError extends ExpectedError<"EDITOR_UNAVAILABLE" | "EDITOR_NOT_OPEN" | "EDITOR_BUSY"> {
  constructor(code: "EDITOR_UNAVAILABLE" | "EDITOR_NOT_OPEN" | "EDITOR_BUSY", message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class GitError extends ExpectedError<"GIT_QUERY_FAILED" | "GIT_PREVIEW_UNAVAILABLE" | "GIT_PROTOCOL_ERROR"> {
  constructor(code: "GIT_QUERY_FAILED" | "GIT_PREVIEW_UNAVAILABLE" | "GIT_PROTOCOL_ERROR", message: string, options?: ErrorOptions) { super(code, message, options); }
}
export class ClipboardError extends ExpectedError<"CLIPBOARD_UNAVAILABLE"> {
  constructor(message: string, options?: ErrorOptions) { super("CLIPBOARD_UNAVAILABLE", message, options); }
}
export type UsageErrorCode = typeof usageErrorCodes[number];
export class UsageError extends ExpectedError<UsageErrorCode> {
  constructor(code: UsageErrorCode, message: string, readonly retryAfterMs?: number, options?: ErrorOptions) { super(code, message, options); }
}
export class CapabilityError extends ExpectedError<"UNSUPPORTED_CAPABILITY"> {
  constructor(message: string) { super("UNSUPPORTED_CAPABILITY", message); }
}
export class RemoteError extends ExpectedError {
  constructor(code: ErrorCode, message: string, readonly outcome: "rejected" | "unknown" = "rejected") { super(code, message); }
}

export function systemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
const fileCodes = new Set(["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "EISDIR", "ENOTDIR", "EEXIST", "EMFILE", "ENFILE", "ENAMETOOLONG", "ELOOP"]);
export function knownError(error: unknown): ExpectedError | null {
  if (error instanceof ExpectedError) return error;
  if (error instanceof AggregateError) {
    const errors = error.errors.map((item: unknown) => knownError(item));
    if (errors.every((item): item is ExpectedError => item !== null)) return new CleanupError(error.message, errors);
    return null;
  }
  if (error instanceof Error && error.name === "AbortError") return new CancelledError(undefined, { cause: error });
  const code = systemCode(error);
  if (code && fileCodes.has(code)) return new StorageError(`Filesystem operation failed (${code}).`, code, { cause: error });
  return null;
}

// Only at exception-based SDK/OS boundaries. Unknown bugs retain their original object/stack.
export async function capture<T>(operation: () => Promise<T>): Promise<Result<T, ExpectedError>> {
  try { return ok(await operation()); }
  catch (error) { const expected = knownError(error); if (expected) return err(expected); throw error; }
}

export async function collectCleanup(tasks: readonly Promise<Result<void, ExpectedError>>[], message: string): Promise<Result<void, CleanupError>> {
  const settled = await Promise.allSettled(tasks);
  const errors: unknown[] = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : result.value.ok ? [] : [result.value.error]);
  if (!errors.length) return ok(undefined);
  if (errors.every((error): error is ExpectedError => error instanceof ExpectedError)) return err(new CleanupError(message, errors));
  throw new AggregateError(errors, message);
}

export async function withCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: Result<T, unknown>;
  try { result = ok(await operation()); }
  catch (error) { result = err(error); }
  try { await cleanup(); }
  catch (cleanupError) {
    if (!result.ok) throw new AggregateError([result.error, cleanupError], "Operation and cleanup failed.");
    throw cleanupError;
  }
  if (!result.ok) throw result.error;
  return result.value;
}

export function parseJson(text: string, context: string): Result<unknown, InputError> {
  try { return ok(JSON.parse(text)); }
  catch (error) { if (error instanceof SyntaxError) return err(new InputError(`Invalid JSON in ${context}.`, { cause: error })); throw error; }
}

// UI boundaries have no caller to propagate to. Keep diagnostics separate from user-safe text.
export function reportUnexpected(error: unknown, context: string): string {
  console.error(`[radian:${context}] Unexpected failure`, error);
  return `Unexpected ${context} failure. Inspect the terminal/runtime log.`;
}
