import { ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

// Amortized growth bounds retained memory by bytes, not by the number of network
// chunks. One-byte fragmentation must not create millions of retained objects.
export class BoundedBytes {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private used = 0;

  constructor(
    private readonly maximum: number,
    private readonly label: string,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError("Receive limit must be a positive byte count.");
    }
  }

  append(bytes: Uint8Array): Result<void, ProtocolError> {
    const size = this.used + bytes.byteLength;
    if (size > this.maximum) {
      return err(
        new ProtocolError(`${this.label} exceeds the ${this.maximum} byte receive limit.`),
      );
    }
    if (size > this.buffer.byteLength) {
      const capacity = Math.min(this.maximum, Math.max(16384, size, this.buffer.byteLength * 2));
      const next = new Uint8Array(capacity);

      next.set(this.buffer.subarray(0, this.used));
      this.buffer = next;
    }

    this.buffer.set(bytes, this.used);
    this.used = size;

    return ok(undefined);
  }

  text(): Result<string, ProtocolError> {
    try {
      return ok(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          this.buffer.subarray(0, this.used),
        ),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        return err(new ProtocolError(`${this.label} contains invalid UTF-8.`, { cause: error }));
      }

      throw error;
    }
  }

  data(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.used);
  }

  reset(): void {
    this.used = 0;
  }
}

// Limits apply to one logical line, not an HTTP chunk. UTF-8 decoding happens only
// after all bytes of a frame arrive, so chunk boundaries cannot corrupt graphemes.
export class NdjsonDecoder {
  private readonly bytes: BoundedBytes;
  private failure: ProtocolError | undefined;

  constructor(maximum: number, label: string) {
    this.bytes = new BoundedBytes(maximum, label);
  }

  *push(chunk: Uint8Array): Generator<Result<string, ProtocolError>> {
    if (this.failure) {
      yield err(this.failure);

      return;
    }

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const added = this.bytes.append(chunk.subarray(offset, end));
      if (!added.ok) {
        this.failure = added.error;
        this.bytes.reset();
        yield added;

        return;
      }
      if (newline < 0) {
        return;
      }

      const frame = this.bytes.text();
      this.bytes.reset();
      if (!frame.ok) {
        this.failure = frame.error;
        yield frame;

        return;
      }

      yield frame;
      offset = newline + 1;
    }
  }
}
