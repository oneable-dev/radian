import { ConnectionError, parseJson, ProtocolError, RemoteError, systemCode, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { WireError } from "./protocol.ts";
import type { RuntimePaths } from "./storage.ts";

export async function transport(paths: RuntimePaths, path: string, options: RequestInit): Promise<Result<Response, ConnectionError>> {
  try { return ok(await fetch(`http://localhost${path}`, { ...options, unix: paths.socket })); }
  catch (error) { const known = connectionError(error); if (known) return err(known); throw error; }
}
export function connectionError(error: unknown): ConnectionError | null {
  const code = systemCode(error);
  if (code === "ENOENT" || code === "ECONNREFUSED") return new ConnectionError("RUNTIME_ABSENT", "No runtime service is listening.", { cause: error });
  if ((error instanceof Error && error.name === "TimeoutError") || code === "ETIMEDOUT") return new ConnectionError("CONNECTION_TIMEOUT", "Runtime request timed out.", { cause: error });
  if (["EACCES", "EPERM", "ECONNRESET", "EPIPE", "EIO"].includes(code ?? "")) return new ConnectionError("CONNECTION_FAILED", `Runtime connection failed (${code}).`, { cause: error });
  return null;
}
export async function readJson(response: Response): Promise<Result<unknown, ExpectedError>> {
  let text: string;
  try { text = await response.text(); }
  catch (error) { const known = connectionError(error); if (known) return err(known); throw error; }
  const json = parseJson(text, "runtime response"); return json.ok ? json : err(new ProtocolError(json.error.message, { cause: json.error }));
}
export function remoteError(error: string | WireError): RemoteError {
  return typeof error === "string" ? new RemoteError("LEGACY_REMOTE_ERROR", error, "unknown") : new RemoteError(error.code, error.message, error.outcome);
}
