import { InputRenderable, type CliRenderer } from "@opentui/core";
import { InputField, type InputLayout } from "./input-field.ts";

type Options = { id: string; placeholder: string; fieldId?: string };

// Every app-owned query uses this field; matching and candidate navigation stay with its owner.
export class SearchInput extends InputRenderable {
  readonly field: InputField;

  constructor(renderer: CliRenderer, options: Options) {
    super(renderer, { id: options.id, placeholder: options.placeholder, width: "auto", flexGrow: 1,
      minWidth: 0, flexShrink: 0, maxLength: 256 });
    this.field = new InputField(renderer, this, "search", options.fieldId ?? `${options.id}-field`);
  }

  clear(): void { if (this.value) this.value = ""; }
  fit(availableHeight: number): InputLayout { return this.field.fit(1, Math.min(3, availableHeight)); }
}
