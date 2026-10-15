import { Value } from "typebox/value";
import { ConnectionError, InputError, parseJson, ProtocolError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { editorFrameSchema, maxFrameBytes, replySchema, type EditorFrame, type RuntimeCommand } from "./protocol.ts";
import type { RuntimePaths } from "./storage.ts";
import { connectionError, readJson, remoteError, transport } from "./transport.ts";

type Send = (command: RuntimeCommand) => Promise<Result<string | null, ExpectedError>>;
export class EditorConnection {
  readonly lease = crypto.randomUUID();
  private readonly abort = new AbortController();
  private readonly finished = Promise.withResolvers<void>();
  readonly closed = this.finished.promise;
  private stream: Promise<void> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private failed = false;
  private queuedBytes = 0;
  private attached = false;
  private revision = -1;

  constructor(private readonly paths: RuntimePaths, readonly id: string, private readonly send: Send,
    private readonly onFrame: (frame: EditorFrame) => void, private readonly onFailure: (error: unknown) => void) {}

  async attach(): Promise<Result<void, ExpectedError>> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.abort.abort(); }, 2000);
    try {
      const response = await transport(this.paths, `/editor/events?id=${encodeURIComponent(this.id)}&lease=${this.lease}`, { signal: this.abort.signal });
      if (!response.ok) return response;
      if (!response.value.ok) {
        const body = await readJson(response.value); if (!body.ok) return body;
        return Value.Check(replySchema, body.value) && !body.value.ok ? err(remoteError(body.value.error)) : err(new ProtocolError("Malformed editor error response."));
      }
      if (!response.value.body) return err(new ProtocolError("Missing editor stream."));
      const ready = Promise.withResolvers<Result<void, ExpectedError>>();
      this.stream = this.consume(response.value.body, () => { this.attached = true; ready.resolve(ok(undefined)); }).then((result) => {
        ready.resolve(result);
        if (!result.ok && this.attached && !this.closing) this.fail(result.error);
      }).catch((error: unknown) => { ready.reject(error); if (this.attached && !this.closing) this.fail(error); });
      const result = await ready.promise;
      return timedOut ? err(new ConnectionError("CONNECTION_TIMEOUT", "Editor attachment timed out; no input was sent.")) : result;
    } catch (error) {
      if (timedOut) return err(new ConnectionError("CONNECTION_TIMEOUT", "Editor attachment timed out; no input was sent."));
      throw error;
    } finally { clearTimeout(timer); }
  }
  input(data: Uint8Array): void {
    if (this.queuedBytes + data.byteLength > 131072) { this.fail(new InputError("Editor input queue is full; further input was not sent.")); return; }
    // Preserve raw UTF-8 and escape bytes. Each accepted byte is submitted at most once.
    for (let offset = 0; offset < data.byteLength; offset += 65536) {
      const chunk = data.subarray(offset, offset + 65536);
      this.enqueue({ type: "editor-input", editorId: this.id, lease: this.lease, data: Buffer.from(chunk).toString("base64") }, chunk.byteLength);
    }
  }
  resize(cols: number, rows: number): void {
    this.enqueue({ type: "editor-resize", editorId: this.id, lease: this.lease,
      cols: Math.max(2, Math.min(500, Math.floor(cols))), rows: Math.max(1, Math.min(200, Math.floor(rows))) }, 0);
  }
  private enqueue(command: RuntimeCommand, bytes: number): void {
    if (this.failed || this.closing) return;
    this.queuedBytes += bytes;
    this.pending = this.pending.then(async () => {
      if (this.failed) return;
      const result = await this.send(command);
      if (!result.ok) this.fail(result.error);
    }).catch((error: unknown) => this.fail(error)).finally(() => { this.queuedBytes -= bytes; });
  }
  private fail(error: unknown): void { if (this.failed) return; this.failed = true; this.onFailure(error); }
  disconnect(): Promise<void> {
    this.closing ??= this.detach(); return this.closing;
  }
  private async detach(): Promise<void> {
    try {
      await this.pending;
      if (this.attached) {
        const result = await this.send({ type: "editor-detach", editorId: this.id, lease: this.lease });
        if (!result.ok && !this.failed) this.fail(result.error);
      }
    } finally {
      this.abort.abort(); await this.stream; this.finished.resolve();
    }
  }
  private async consume(body: ReadableStream<Uint8Array>, ready: () => void): Promise<Result<void, ExpectedError>> {
    const reader = body.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      while (!this.abort.signal.aborted) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); }
        catch (error) { if (this.abort.signal.aborted) return ok(undefined); const known = connectionError(error); if (known) return err(known); throw error; }
        if (chunk.done) return err(new ConnectionError("CONNECTION_FAILED", "Editor stream ended. Reconnect explicitly; input was not replayed."));
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > maxFrameBytes) return err(new ProtocolError("Editor frame is too large."));
          const parsed = parseJson(line, "editor frame"); if (!parsed.ok) return err(new ProtocolError(parsed.error.message));
          if (!Value.Check(editorFrameSchema, parsed.value) || parsed.value.id !== this.id) return err(new ProtocolError("Editor frame identity or shape is invalid."));
          if (parsed.value.revision !== this.revision) { this.revision = parsed.value.revision; this.onFrame(parsed.value); }
          ready();
        }
        if (Buffer.byteLength(buffer) > maxFrameBytes) return err(new ProtocolError("Editor frame is too large."));
      }
      return ok(undefined);
    } finally {
      try { await reader.cancel(); }
      catch (error) { if (!this.abort.signal.aborted && !connectionError(error)) this.fail(error); }
      reader.releaseLock();
    }
  }
}
