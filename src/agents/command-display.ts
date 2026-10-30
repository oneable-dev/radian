import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { HistoryError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const commandDisplayEntryType = "radian.command-display.v1";
const commandDisplaySchema = Type.Array(
  Type.Object(
    {
      text: Type.String(),
      commandName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);
const savedCommandDisplaySchema = Type.Object(
  {
    messageId: Type.String({ minLength: 1 }),
    parts: commandDisplaySchema,
  },
  { additionalProperties: false },
);

export type CommandDisplay = ReadonlyArray<Readonly<Static<typeof commandDisplaySchema>[number]>>;

export function commandDisplay(
  text: string,
  templateNames: readonly string[],
): CommandDisplay | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !templateNames.includes(match[1]!)) return undefined;

  const name = match[1]!;
  const args = match[2] ?? "";

  return [{ commandName: name, text: `/${name}` }, ...(args ? [{ text: args }] : [])];
}

export function parseCommandDisplay(
  value: unknown,
): Result<Static<typeof savedCommandDisplaySchema>, HistoryError> {
  return Value.Check(savedCommandDisplaySchema, value)
    ? ok(value)
    : err(new HistoryError("HISTORY_CORRUPT", "Saved command display metadata is invalid."));
}
