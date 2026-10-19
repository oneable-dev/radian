import { expect, test } from "bun:test";
import { BoundedBytes, NdjsonDecoder } from "./frames.ts";
import { expectError, expectOk } from "../testing/results.ts";

const encoder = new TextEncoder();

test("한글·emoji가 한 바이트씩 나뉘어 도착해도 프레임 원문을 보존한다", () => {
  const first = JSON.stringify({ text: "한글👩🏽‍💻" }), second = JSON.stringify({ text: "e\u0301" });
  const decoder = new NdjsonDecoder(128, "Test snapshot"), frames: string[] = [];
  for (const byte of encoder.encode(`${first}\n${second}\n`)) {
    for (const result of decoder.push(Uint8Array.of(byte))) frames.push(expectOk(result));
  }
  expect(frames).toEqual([first, second]);
});

test("한 HTTP 청크에 여러 프레임이 합쳐져도 한도는 각 프레임에 따로 적용한다", () => {
  const decoder = new NdjsonDecoder(4, "Test snapshot");
  const results = [...decoder.push(encoder.encode("1234\n5678\n"))];

  expect(results.map(expectOk)).toEqual(["1234", "5678"]);
});

test("줄바꿈 전이라도 한도를 넘은 프레임은 즉시 거부하고 실패 뒤 입력을 정상값으로 취급하지 않는다", () => {
  const decoder = new NdjsonDecoder(4, "Test snapshot");
  expect([...decoder.push(encoder.encode("1234"))]).toEqual([]);
  const failed = [...decoder.push(encoder.encode("5"))];

  expect(failed).toHaveLength(1); expect(expectError(failed[0]!).code).toBe("PROTOCOL_ERROR");
  expect(expectError([...decoder.push(encoder.encode("ok\n"))][0]!)).toBe(expectError(failed[0]!));
});

test("문자 수가 아닌 UTF-8 바이트를 제한하고 완성 프레임의 경계값은 허용한다", () => {
  const frame = '"가"', size = encoder.encode(frame).byteLength;
  expect(frame.length).toBeLessThan(size);
  expect(expectOk([...new NdjsonDecoder(size, "Test snapshot").push(encoder.encode(frame + "\n"))][0]!)).toBe(frame);
  expect(expectError([...new NdjsonDecoder(size - 1, "Test snapshot").push(encoder.encode(frame + "\n"))][0]!).code).toBe("PROTOCOL_ERROR");
});

test("앞의 정상 프레임은 순서대로 내보내고 뒤의 손상된 UTF-8은 실패 원인을 보존한다", () => {
  const decoder = new NdjsonDecoder(128, "Test snapshot");
  const bytes = Uint8Array.from([...encoder.encode("ok\n"), 0xff, 10]);
  const results = [...decoder.push(bytes)];

  expect(expectOk(results[0]!)).toBe("ok");
  const error = expectError(results[1]!); expect(error.code).toBe("PROTOCOL_ERROR"); expect(error.cause).toBeInstanceOf(TypeError);
});

test("바이트 버퍼는 실패한 추가 작업으로 기존 데이터를 바꾸지 않고 초기화 뒤 재사용한다", () => {
  const bytes = new BoundedBytes(4, "Test response");
  expectOk(bytes.append(encoder.encode("1234")));
  expect(expectError(bytes.append(encoder.encode("5"))).code).toBe("PROTOCOL_ERROR");
  expect(expectOk(bytes.text())).toBe("1234");
  bytes.reset(); expectOk(bytes.append(encoder.encode("next")));
  expect(expectOk(bytes.text())).toBe("next");
  expect(() => new BoundedBytes(0, "Invalid configuration")).toThrow(RangeError);
});
