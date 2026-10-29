import { InputRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { InputField, type InputLayout } from "./input-field.ts";
import { uiTheme } from "./theme.ts";
import { paintText, type StyleGroup } from "./theme-styles.ts";

type Options = { id: string; fieldId?: string; title?: string; backgroundStyle?: StyleGroup };

type Counts = Readonly<{ matched: number; total: number; limit?: number }>;

// Every app-owned query uses this field; matching and candidate navigation stay with its owner.
export class SearchInput extends InputRenderable {
  readonly field: InputField;
  private readonly count: TextRenderable | undefined;

  constructor(renderer: CliRenderer, options: Options) {
    super(renderer, {
      id: options.id,
      width: "auto",
      flexGrow: 1,
      minWidth: 0,
      flexShrink: options.title ? 1 : 0,
      maxLength: 256,
    });
    this.field = new InputField(
      renderer,
      this,
      "search",
      options.fieldId ?? `${options.id}-field`,
      options.backgroundStyle ?? (options.title ? "ui.popup" : undefined),
    );
    if (options.title) {
      this.setTitle(options.title);

      const prompt = new TextRenderable(renderer, {
        id: `${options.id}-prompt`,
        content: ">",
        width: 1,
        height: 1,
        marginRight: 1,
        flexShrink: 0,
        wrapMode: "none",
        selectable: false,
      });
      const count = (this.count = new TextRenderable(renderer, {
        id: `${options.id}-count`,
        width: 0,
        height: 1,
        marginLeft: 1,
        flexShrink: 0,
        wrapMode: "none",
        selectable: false,
        visible: false,
      }));

      this.field.insertBefore(prompt, this);
      this.field.add(this.count);
      uiTheme(renderer).bindStyles(this.field, (styles) => {
        paintText(prompt, styles["ui.popupTitle"]);
        paintText(count, styles["ui.muted"]);
      });
    }
  }

  setTitle(title: string): void {
    this.field.setTitle(title);
  }

  setCounts(counts: Counts | null): void {
    if (!this.count) {
      return;
    }

    const limited = counts?.limit !== undefined && counts.matched > counts.limit;
    const text = counts
      ? `${counts.matched}/${counts.total}${limited ? ` · ${counts.limit} shown` : ""}`
      : "";
    this.count.content = text;
    this.count.width = text.length;
    this.count.visible = counts !== null;
  }

  clear(): void {
    if (this.value) {
      this.value = "";
    }
  }

  fit(availableHeight: number): InputLayout {
    return this.field.fit(1, Math.min(3, availableHeight));
  }
}
