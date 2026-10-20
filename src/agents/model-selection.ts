import { Type, type Static } from "typebox";
import type { CompletionItem } from "./completion.ts";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const identifier = Type.String({ minLength: 1, maxLength: 4096 });
export const modelIdentitySchema = Type.Object({ provider: identifier, id: identifier }, { additionalProperties: false });
export type ModelIdentity = Static<typeof modelIdentitySchema>;
export const modelCatalogQuerySchema = Type.Object({ sessionId: identifier, conversationId: identifier }, { additionalProperties: false });
export const modelCatalogSchema = Type.Object({
  conversationId: identifier,
  current: Type.Union([modelIdentitySchema, Type.Null()]),
  models: Type.Array(Type.Object({ provider: identifier, id: identifier, name: Type.String(),
    contextWindow: Type.Number({ minimum: 0 }), reasoning: Type.Boolean(), images: Type.Boolean() })),
});
export type ModelCatalog = Static<typeof modelCatalogSchema>;
export const modelCommand: CompletionItem = { kind: "command", value: "model", description: "Choose a model for this session in a searchable popup" };

// Reserve the host command even on paths without a popup; never bill it as ordinary model input.
export function parseModelCommand(text: string): Result<boolean, InputError> {
  if (!/^\/model(?:\s|$)/u.test(text)) return ok(false);
  return text.slice(6).trim() ? err(new InputError("Usage: /model (choose a model from the popup; no arguments).")) : ok(true);
}
