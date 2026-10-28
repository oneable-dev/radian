import { Type, type Static } from "typebox";
import { requestSummarySchema } from "./request-summary.ts";

// A result identity fences acknowledgement independently of a tab or conversation's lifetime.
export const sessionResultSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 4096 }),
    outcome: Type.Union([
      Type.Literal("complete"),
      Type.Literal("error"),
      Type.Literal("unfinished"),
      Type.Literal("cancelled"),
    ]),
    completedAt: Type.Integer({ minimum: 0, maximum: 8640000000000000 }),
    request: Type.Optional(requestSummarySchema),
    cancellation: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("lifecycle")])),
  },
  { additionalProperties: false },
);

export type SessionResult = Static<typeof sessionResultSchema>;

export function needsAttention(result: SessionResult): boolean {
  return result.outcome !== "cancelled" || result.cancellation === undefined;
}
