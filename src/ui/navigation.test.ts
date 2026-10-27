import { expect, test } from "bun:test";
import { halfPageStep } from "./navigation.ts";

test.each([
  [0, 1, 1],
  [1, 1, 1],
  [11, 1, 5],
  [11, 3, 1],
  [12, 3, 2],
  [20, 2, 5],
])(
  "Viewport height %i and row stride %i jump %i candidates per half-page",
  (height, stride, expected) => {
    // Tiny viewports move at least one item and odd heights round down.
    const distance = halfPageStep(height, stride);

    // Use actual viewport heights and row spacing instead of fixed key counts.
    expect(distance).toBe(expected);
  },
);
