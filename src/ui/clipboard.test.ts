import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Clipboard } from "./clipboard.ts";
import { expectError } from "../testing/results.ts";

test("Clipboard reads pass real SDK MIME validation and return cancellation Results", async () => {
  // The SDK validates MIME types before cancellation, so no user's clipboard is read or overwritten.
  const app = await createTestRenderer({ width: 40, height: 4 });
  const clipboard = new Clipboard(app.renderer);
  try {
    const result = await clipboard.read(AbortSignal.abort());

    // A valid request reaches cancellation instead of rejecting with a MIME configuration TypeError.
    expect(expectError(result).code).toBe("CANCELLED");
  } finally { await clipboard.dispose(); await app.dispose(); }
});
