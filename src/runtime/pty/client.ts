import { Value } from "typebox/value";
import {
  ConnectionError,
  InputError,
  parseJson,
  ProtocolError,
  reportUnexpected,
  type ExpectedError,
} from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import {
  ptyFrameSchema,
  maxFrameBytes,
  replySchema,
  terminalTextSchema,
  type PtyFrame,
  type TerminalText,
} from "../protocol.ts";
import type { RuntimePaths } from "../storage.ts";
import { connectionError, readJson, remoteError, transport } from "../transport.ts";

export type PtyRequest =
  | { type: "input"; lease: string; data: string }
  | { type: "resize"; lease: string; cols: number; rows: number }
  | { type: "detach"; lease: string }
  | { type: "scroll"; lease: string; lines: number }
  | { type: "read"; lease: string };
type Send = (command: PtyRequest) => Promise<Result<unknown, ExpectedError>>;
export class PtyConnection {
  readonly lease = crypto.randomUUID();
  private readonly abort = new AbortController();
  private readonly finished = Promise.withResolvers<void>();
  readonly closed = this.finished.promise;
  private stream: Promise<void> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private failed = false;
  private invalidated = false;
  private queuedBytes = 0;
  private attached = false;
  private revision = -1;

  constructor(
    private readonly paths: RuntimePaths,
    readonly id: string,
    private readonly endpoint: string,
    private readonly send: Send,
    private readonly onFrame: (frame: PtyFrame) => void,
    private readonly onFailure: (error: unknown) => void,
    private readonly instance?: string,
  ) {}

  async attach(): Promise<Result<void, ExpectedError>> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.abort.abort();
    }, 2000);
    try {
      const response = await transport(
        this.paths,
        `${this.endpoint}?id=${encodeURIComponent(this.id)}&lease=${this.lease}`,
        {
          signal: this.abort.signal,
          ...(this.instance ? { headers: { "X-Radian-Instance": this.instance } } : {}),
        },
      );
      if (!response.ok) return response;
      if (!response.value.ok) {
        const body = await readJson(response.value);
        if (!body.ok) return body;
        return Value.Check(replySchema, body.value) && !body.value.ok
          ? err(remoteError(body.value.error))
          : err(new ProtocolError("Malformed terminal error response."));
      }
      if (!response.value.body) return err(new ProtocolError("Missing terminal stream."));
      const ready = Promise.withResolvers<Result<void, ExpectedError>>();
      this.stream = this.consume(response.value.body, () => {
        this.attached = true;
        ready.resolve(ok(undefined));
      })
        .then((result) => {
          ready.resolve(result);
          if (!result.ok && this.attached && !this.closing) this.fail(result.error);
        })
        .catch((error: unknown) => {
          ready.reject(error);
          if (this.attached && !this.closing) this.fail(error);
        });
      const result = await ready.promise;
      return timedOut
        ? err(
            new ConnectionError(
              "CONNECTION_TIMEOUT",
              "Terminal attachment timed out; no input was sent.",
            ),
          )
        : result;
    } catch (error) {
      const aborted =
        error === this.abort.signal.reason ||
        (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      if (timedOut && aborted)
        return err(
          new ConnectionError(
            "CONNECTION_TIMEOUT",
            "Terminal attachment timed out; no input was sent.",
            { cause: error },
          ),
        );
      if (this.closing && aborted)
        return err(
          new ConnectionError("CONNECTION_FAILED", "Terminal attachment was cancelled.", {
            cause: error,
          }),
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  input(data: Uint8Array): void {
    if (this.queuedBytes + data.byteLength > 131072) {
      this.fail(new InputError("Terminal input queue is full; further input was not sent."));
      return;
    }
    // Preserve raw UTF-8 and escape bytes. Each accepted byte is submitted at most once.
    for (let offset = 0; offset < data.byteLength; offset += 65536) {
      const chunk = data.subarray(offset, offset + 65536);
      this.enqueue(
        { type: "input", lease: this.lease, data: Buffer.from(chunk).toString("base64") },
        chunk.byteLength,
      );
    }
  }
  resize(cols: number, rows: number): void {
    this.enqueue(
      {
        type: "resize",
        lease: this.lease,
        cols: Math.max(2, Math.min(500, Math.floor(cols))),
        rows: Math.max(1, Math.min(200, Math.floor(rows))),
      },
      0,
    );
  }
  scroll(lines: number): void {
    this.enqueue(
      {
        type: "scroll",
        lease: this.lease,
        lines: Math.max(-10000, Math.min(10000, Math.round(lines))),
      },
      0,
    );
  }
  async read(): Promise<Result<TerminalText, ExpectedError>> {
    await this.pending;
    if (this.failed || this.closing)
      return err(
        new ConnectionError("CONNECTION_FAILED", "Terminal is disconnected; output was not read."),
      );
    const result = await this.send({ type: "read", lease: this.lease });
    if (!result.ok) return result;
    if (this.failed || this.closing)
      return err(
        new ConnectionError("CONNECTION_FAILED", "Terminal changed while reading output."),
      );
    if (typeof result.value !== "string")
      return err(new ProtocolError("Missing terminal output snapshot."));
    const parsed = parseJson(result.value, "terminal output");
    if (!parsed.ok) return err(new ProtocolError(parsed.error.message));
    return Value.Check(terminalTextSchema, parsed.value)
      ? ok(parsed.value)
      : err(new ProtocolError("Malformed terminal output snapshot."));
  }
  private enqueue(command: PtyRequest, bytes: number): void {
    if (this.failed || this.closing) return;
    this.queuedBytes += bytes;
    this.pending = this.pending
      .then(async () => {
        if (this.failed) return;
        const result = await this.send(command);
        if (!result.ok) this.fail(result.error);
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.onFailure(error);
  }
  invalidate(error: ExpectedError): void {
    this.invalidated = true;
    this.fail(error);
    this.abort.abort();
    // Read cancellation releases the old lease. Never POST a stale detach or queued
    // input to a replacement runtime; already-sent input has an uncertain outcome.
    void this.disconnect().catch((error: unknown) => {
      reportUnexpected(error, "PTY invalidation cleanup");
    });
  }
  disconnect(): Promise<void> {
    this.closing ??= this.detach();
    return this.closing;
  }
  private async detach(): Promise<void> {
    try {
      await this.pending;
      if (this.attached && !this.invalidated) {
        const result = await this.send({ type: "detach", lease: this.lease });
        if (!result.ok && !this.failed) this.fail(result.error);
      }
    } finally {
      this.abort.abort();
      await this.stream;
      this.finished.resolve();
    }
  }
  private async consume(
    body: ReadableStream<Uint8Array>,
    ready: () => void,
  ): Promise<Result<void, ExpectedError>> {
    const reader = body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.abort.signal.aborted) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (this.abort.signal.aborted) return ok(undefined);
          const known = connectionError(error);
          if (known) return err(known);
          throw error;
        }
        if (chunk.done)
          return err(
            new ConnectionError(
              "CONNECTION_FAILED",
              "Terminal stream ended. Reconnect explicitly; input was not replayed.",
            ),
          );
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > maxFrameBytes)
            return err(new ProtocolError("Terminal frame is too large."));
          const parsed = parseJson(line, "terminal frame");
          if (!parsed.ok) return err(new ProtocolError(parsed.error.message));
          if (!Value.Check(ptyFrameSchema, parsed.value) || parsed.value.id !== this.id)
            return err(new ProtocolError("Terminal frame identity or shape is invalid."));
          if (parsed.value.revision !== this.revision) {
            this.revision = parsed.value.revision;
            this.onFrame(parsed.value);
          }
          ready();
        }
        if (Buffer.byteLength(buffer) > maxFrameBytes)
          return err(new ProtocolError("Terminal frame is too large."));
      }
      return ok(undefined);
    } finally {
      try {
        await reader.cancel();
      } catch (error) {
        if (
          !connectionError(error) &&
          !(this.abort.signal.aborted && error instanceof Error && error.name === "AbortError")
        )
          reportUnexpected(error, "PTY stream cleanup");
      }
      reader.releaseLock();
    }
  }
}
