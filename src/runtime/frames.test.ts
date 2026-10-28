import { expect, test } from "bun:test";
import { BoundedBytes, NdjsonDecoder } from "./frames.ts";
import { expectError, expectOk } from "../testing/results.ts";

const encoder = new TextEncoder();

test("Korean/emoji split into individual bytes preserve complete frame source", () => {
  const first = JSON.stringify({ text: "한글👩🏽‍💻" });
  const second = JSON.stringify({ text: "e\u0301" });
  const decoder = new NdjsonDecoder(128, "Test snapshot");
  const frames: string[] = [];
  for (const byte of encoder.encode(`${first}\n${second}\n`)) {
    for (const result of decoder.push(Uint8Array.of(byte))) {
      frames.push(expectOk(result));
    }
  }

  expect(frames).toEqual([first, second]);
});

test("Multiple frames per HTTP chunk receive independent limits", () => {
  const decoder = new NdjsonDecoder(4, "Test snapshot");
  const results = [...decoder.push(encoder.encode("1234\n5678\n"))];

  expect(results.map(expectOk)).toEqual(["1234", "5678"]);
});

test("Oversized frames fail before newlines and subsequent input never restores success", () => {
  const decoder = new NdjsonDecoder(4, "Test snapshot");
  expect([...decoder.push(encoder.encode("1234"))]).toEqual([]);

  const failed = [...decoder.push(encoder.encode("5"))];

  expect(failed).toHaveLength(1);
  expect(expectError(failed[0]!).code).toBe("PROTOCOL_ERROR");
  expect(expectError([...decoder.push(encoder.encode("ok\n"))][0]!)).toBe(expectError(failed[0]!));
});

test("UTF-8 byte limits apply instead of character counts and exact boundaries pass", () => {
  const frame = '"가"';
  const size = encoder.encode(frame).byteLength;

  expect(frame.length).toBeLessThan(size);
  expect(
    expectOk([...new NdjsonDecoder(size, "Test snapshot").push(encoder.encode(frame + "\n"))][0]!),
  ).toBe(frame);
  expect(
    expectError(
      [...new NdjsonDecoder(size - 1, "Test snapshot").push(encoder.encode(frame + "\n"))][0]!,
    ).code,
  ).toBe("PROTOCOL_ERROR");
});

test("Valid preceding frames emit in order while later invalid UTF-8 retains failure causes", () => {
  const decoder = new NdjsonDecoder(128, "Test snapshot");
  const bytes = Uint8Array.from([...encoder.encode("ok\n"), 0xff, 10]);
  const results = [...decoder.push(bytes)];

  expect(expectOk(results[0]!)).toBe("ok");

  const error = expectError(results[1]!);
  expect(error.code).toBe("PROTOCOL_ERROR");
  expect(error.cause).toBeInstanceOf(TypeError);
});

test("Failed byte-buffer appends preserve existing data and reset permits reuse", () => {
  const bytes = new BoundedBytes(4, "Test response");
  expectOk(bytes.append(encoder.encode("1234")));
  expect(expectError(bytes.append(encoder.encode("5"))).code).toBe("PROTOCOL_ERROR");
  expect(expectOk(bytes.text())).toBe("1234");
  bytes.reset();
  expectOk(bytes.append(encoder.encode("next")));
  expect(expectOk(bytes.text())).toBe("next");
  expect(() => new BoundedBytes(0, "Invalid configuration")).toThrow(RangeError);
});
