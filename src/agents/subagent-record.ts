import { Type, type Static } from "typebox";
import { requestSummarySchema } from "./request-summary.ts";

// Coordination records are separate from transient UI rows and never restore live handles.
export const ownedSubagentRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: Type.Union([
    Type.Literal("working"),
    Type.Literal("complete"),
    Type.Literal("failure"),
    Type.Null(),
  ]),
  task: Type.Optional(Type.String()),
  output: Type.String(),
  finalOutput: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.Number()),
  hidden: Type.Boolean(),
  request: Type.Optional(requestSummarySchema),
  runTiming: Type.Optional(Type.Object({ startedAt: Type.Number(), elapsedMs: Type.Number() })),
  progress: Type.Array(Type.Object({ message: Type.String(), createdAt: Type.Number() }), {
    maxItems: 16,
  }),
});
export type OwnedSubagentRecord = Static<typeof ownedSubagentRecordSchema>;
