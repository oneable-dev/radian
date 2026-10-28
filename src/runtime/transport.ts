import {
  ConnectionError,
  parseJson,
  ProtocolError,
  RemoteError,
  reportUnexpected,
  systemCode,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { maxFrameBytes, type WireError } from "./protocol.ts";
import { BoundedBytes } from "./frames.ts";
import type { RuntimePaths } from "./storage.ts";

export async function transport(
  paths: RuntimePaths,
  path: string,
  options: RequestInit,
): Promise<Result<Response, ConnectionError>> {
  try {
    return ok(await fetch(`http://localhost${path}`, { ...options, unix: paths.socket }));
  } catch (error) {
    const known = connectionError(error);
    if (known) {
      return err(known);
    }

    throw error;
  }
}

export function connectionError(error: unknown): ConnectionError | null {
  const code = systemCode(error);
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return new ConnectionError("RUNTIME_ABSENT", "No runtime service is listening.", {
      cause: error,
    });
  }
  if ((error instanceof Error && error.name === "TimeoutError") || code === "ETIMEDOUT") {
    return new ConnectionError("CONNECTION_TIMEOUT", "Runtime request timed out.", {
      cause: error,
    });
  }
  if (["EACCES", "EPERM", "ECONNRESET", "EPIPE", "EIO"].includes(code ?? "")) {
    return new ConnectionError("CONNECTION_FAILED", `Runtime connection failed (${code}).`, {
      cause: error,
    });
  }

  return null;
}

type ReceiveOptions = { maximumBytes?: number; label?: string };

export async function readJson(
  response: Response,
  options: ReceiveOptions = {},
): Promise<Result<unknown, ExpectedError>> {
  const received = await readResponse(response, options);
  if (!received.ok) {
    return received;
  }

  const text = received.value.text();
  if (!text.ok) {
    return text;
  }

  const json = parseJson(text.value, "runtime response");

  return json.ok ? json : err(new ProtocolError(json.error.message, { cause: json.error }));
}

export async function readBytes(
  response: Response,
  options: ReceiveOptions,
): Promise<Result<Uint8Array<ArrayBuffer>, ExpectedError>> {
  const received = await readResponse(response, options);

  return received.ok ? ok(received.value.data()) : received;
}

async function readResponse(
  response: Response,
  options: ReceiveOptions,
): Promise<Result<BoundedBytes, ExpectedError>> {
  if (!response.body) {
    return err(new ProtocolError("Runtime response is empty."));
  }

  const maximum = options.maximumBytes ?? maxFrameBytes;
  const label = options.label ?? "Runtime response";
  const bytes = new BoundedBytes(maximum, label);
  const reader = response.body.getReader();
  let ended = false;
  try {
    if (Number(response.headers.get("Content-Length")) > maximum) {
      return err(new ProtocolError(`${label} exceeds the ${maximum} byte receive limit.`));
    }
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        ended = true;

        const known = connectionError(error);
        if (known) {
          return err(known);
        }

        throw error;
      }
      if (chunk.done) {
        ended = true;
        break;
      }

      const added = bytes.append(chunk.value);
      if (!added.ok) {
        return added;
      }
    }

    return ok(bytes);
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch (error) {
        if (!connectionError(error) && !(error instanceof Error && error.name === "AbortError")) {
          reportUnexpected(error, "response cleanup");
        }
      }
    }

    reader.releaseLock();
  }
}

export function remoteError(error: string | WireError): RemoteError {
  return typeof error === "string"
    ? new RemoteError("LEGACY_REMOTE_ERROR", error, "unknown")
    : new RemoteError(error.code, error.message, error.outcome);
}
