import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { HistoryError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const runCompletionEntryType = "radian.run-completion.v1";
const timestamp = Type.Integer({ minimum: 0, maximum: 8640000000000000 });
export const runCompletionSchema = Type.Object(
  {
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    outcome: Type.Union([
      Type.Literal("complete"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
      Type.Literal("unfinished"),
    ]),
    warning: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export type RunCompletion = Static<typeof runCompletionSchema>;

export type RunClock = { wallTime(): number; monotonicTime(): number };

export const systemRunClock: RunClock = {
  wallTime: () => Date.now(),
  monotonicTime: () => performance.now(),
};

export function parseRunCompletion(value: unknown): Result<RunCompletion, HistoryError> {
  return Value.Check(runCompletionSchema, value)
    ? ok(value)
    : err(new HistoryError("HISTORY_CORRUPT", "Saved run completion metadata is invalid."));
}
