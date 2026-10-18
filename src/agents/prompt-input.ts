import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const index = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const promptPartSchema = Type.Union([
  Type.Object({ kind: Type.Literal("paste"), index, text: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("image"), index, path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("file"), index, path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
]);
export type PromptPart = Static<typeof promptPartSchema>;
export const promptDraftSchema = Type.Object({
  value: Type.String(), cursor: Type.Integer({ minimum: 0 }),
  tokens: Type.Array(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }), part: promptPartSchema }, { additionalProperties: false })),
  next: Type.Object({ paste: index, image: index, file: index }, { additionalProperties: false }),
}, { additionalProperties: false });
export type PromptDraft = Static<typeof promptDraftSchema>;
export type PromptSubmission = { text: string; images: string[] };

export function promptPartLabel(part: PromptPart): string {
  if (part.kind !== "paste") return `[${part.kind === "image" ? "Image" : "File"} #${part.index}]`;
  let count = 0; for (const _character of part.text) count++;
  return `[Pasted Content ${count} chars]`;
}
export function validatePromptDraft(value: unknown): Result<PromptDraft, InputError> {
  if (!Value.Check(promptDraftSchema, value)) return err(new InputError("Malformed input draft."));
  let end = 0;
  for (const token of value.tokens) {
    if (token.part.kind !== "paste" && token.part.path.includes("\0")) return err(new InputError("Attachment paths must not contain NUL bytes."));
    if (token.start < end || token.end <= token.start || token.end > value.value.length || value.value.slice(token.start, token.end) !== promptPartLabel(token.part)
      || token.part.index >= value.next[token.part.kind]) return err(new InputError("Input draft attachment ranges are inconsistent."));
    end = token.end;
  }
  return value.cursor <= value.value.length ? ok(value) : err(new InputError("Input draft cursor is outside the text."));
}
export function expandPromptDraft(draft: PromptDraft, inlineImages = true): PromptSubmission {
  let text = "", offset = 0;
  const images: string[] = [];
  for (const token of draft.tokens) {
    text += draft.value.slice(offset, token.start);
    const part = token.part;
    switch (part.kind) {
      case "paste": text += part.text; break;
      case "file": text += `@${JSON.stringify(part.path)}`; break;
      case "image":
        if (inlineImages) { text += promptPartLabel(part); images.push(part.path); }
        else text += `@${JSON.stringify(part.path)}`;
        break;
    }
    offset = token.end;
  }
  return { text: text + draft.value.slice(offset), images };
}
export function collapsedPaste(text: string): boolean {
  // Collapse representation, never data. Control sequences also stay out of the terminal surface.
  return text.length >= 1024 || text.split("\n", 9).length >= 9 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text);
}
