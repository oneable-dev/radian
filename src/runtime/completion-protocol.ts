import { Type } from "typebox";
import { completionLimit } from "../agents/completion.ts";

export const completionQuerySchema = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 4096 }),
  kind: Type.Union([Type.Literal("command"), Type.Literal("file")]),
  query: Type.String({ maxLength: 4096 }),
});
export const completionResultSchema = Type.Object({
  items: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("command"), Type.Literal("skill"), Type.Literal("template"), Type.Literal("file")]),
    value: Type.String({ minLength: 1, maxLength: 4096 }), description: Type.String({ maxLength: 1024 }),
  }), { maxItems: completionLimit }),
  truncated: Type.Boolean(),
});
