import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Clipboard } from "./clipboard.ts";
import { expectError } from "../testing/results.ts";

test("클립보드 읽기는 실제 SDK의 MIME 검증을 통과하고 취소를 Result로 반환한다", async () => {
  // The SDK validates MIME types before cancellation, so no user's clipboard is read or overwritten.
  const app = await createTestRenderer({ width: 40, height: 4 });
  const clipboard = new Clipboard(app.renderer);
  try {
    const result = await clipboard.read(AbortSignal.abort());

    // A valid request reaches cancellation instead of rejecting with a MIME configuration TypeError.
    expect(expectError(result).code).toBe("CANCELLED");
  } finally { await clipboard.dispose(); await app.dispose(); }
});
