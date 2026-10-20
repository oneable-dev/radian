import { Type } from "typebox";
import { completionLimit } from "../agents/completion.ts";

export const completionQuerySchema = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 4096 }),
  kind: Type.Union([Type.Literal("command"), Type.Literal("skill"), Type.Literal("file")]),
  query: Type.String({ maxLength: 4096 }),
});
export const completionItemSchema = Type.Object({
  kind: Type.Union([Type.Literal("command"), Type.Literal("skill"), Type.Literal("template"), Type.Literal("file")]),
  value: Type.String({ minLength: 1, maxLength: 4096 }), description: Type.String({ maxLength: 1024 }),
});
export const completionResultSchema = Type.Object({ items: Type.Array(completionItemSchema, { maxItems: completionLimit }), truncated: Type.Boolean() });
export const completionCatalogQuerySchema = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 4096 }), conversationId: Type.String({ minLength: 1, maxLength: 4096 }) });
// The catalog is not a search page. The HTTP receive budget bounds its encoded size.
export const completionCatalogSchema = Type.Object({ conversationId: Type.String({ minLength: 1, maxLength: 4096 }),
  revision: Type.Integer({ minimum: 0 }), items: Type.Array(completionItemSchema) });
