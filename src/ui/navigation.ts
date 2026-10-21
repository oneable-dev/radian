// Use item strides for candidate jumps; the default measures plain terminal rows.
export function halfPageStep(viewportHeight: number, itemStride = 1): number {
  return Math.max(1, Math.floor(viewportHeight / (2 * itemStride)));
}
