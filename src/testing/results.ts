import { expect } from "bun:test";
import type { Result } from "../result.ts";
import type { ExpectedError } from "../errors.ts";

// Test assertions only. Production callers must branch on Result rather than unwrap expected errors.
export function expectOk<T>(result: Result<T, ExpectedError>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}
export function expectError<T>(result: Result<T, ExpectedError>): ExpectedError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a failed Result.");
  return result.error;
}
