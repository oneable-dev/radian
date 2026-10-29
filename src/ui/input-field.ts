import {
  BoxRenderable,
  RenderableEvents,
  type CliRenderer,
  type TextareaRenderable,
} from "@opentui/core";
import { horizontalInset } from "./spacing.ts";
import { UI_BORDER_STYLE } from "./border-style.ts";
import { uiTheme } from "./theme.ts";
import type { StyleGroup } from "./theme-styles.ts";

export type InputLayout = Readonly<{ rows: number; height: number }>;

type InputKind = "search" | "prompt";

// The field owns spacing and hit testing; native editors retain caret/selection ownership.
export class InputField extends BoxRenderable {
  private inset = -1;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly editor: TextareaRenderable,
    private readonly kind: InputKind,
    id: string,
    private readonly backgroundStyle?: StyleGroup,
  ) {
    super(renderer, {
      id,
      width: "auto",
      minWidth: 0,
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      border: false,
      onMouseDown: (event) => {
        if (event.button === 0 && !editor.focused) {
          editor.focus();
        }
      },
    });
    this.add(editor);

    const theme = uiTheme(renderer);
    theme.input(
      editor,
      kind === "prompt" ? "prompt.input" : "ui.input",
      kind === "prompt" ? "prompt.input" : "ui.inputFocused",
      backgroundStyle,
    );
    theme.bindStyles(this, this.paint);
    editor.on("focused", this.paint);
    editor.on("blurred", this.paint);
    this.onLifecyclePass = this.resize;
    this.once(RenderableEvents.DESTROYED, () => {
      editor.off("focused", this.paint);
      editor.off("blurred", this.paint);
    });
    this.resize();
  }

  setTitle(title: string): void {
    this.border = true;
    this.borderStyle = UI_BORDER_STYLE;
    this.titleAlignment = "center";
    this.title = ` ${title} `;
    this.paint();
  }

  measure(rows: number, availableHeight: number): InputLayout {
    const capacity = Math.max(1, Math.floor(availableHeight));
    // Give editing the last row before spending any space on vertical decoration.
    const padding = Math.min(2, capacity - 1);
    const visibleRows = Math.max(1, Math.min(rows, capacity - padding));

    return { rows: visibleRows, height: visibleRows + padding };
  }

  fit(rows: number, availableHeight: number): InputLayout {
    const layout = this.measure(rows, availableHeight);
    this.editor.height = layout.rows;
    this.height = layout.height;
    if (this.title) {
      this.border = layout.height >= 3;
    }

    return layout;
  }

  private paint = (): void => {
    if (this.isDestroyed) {
      return;
    }

    const styles = uiTheme(this.renderer).styles;
    const surface =
      this.backgroundStyle ??
      (this.kind === "prompt"
        ? "prompt.input"
        : this.editor.focused
          ? "ui.inputFocused"
          : "ui.input");

    this.backgroundColor = styles[surface].bg;
    if (this.title) {
      const border = this.border;
      this.borderColor = styles["ui.popupBorder"].fg;
      this.titleColor = styles["ui.popupTitle"].fg;
      // OpenTUI color setters enable borders; a compact layout may have hidden this one.
      this.border = border;
    }
  };

  private resize = (): void => {
    if (this.isDestroyed) {
      return;
    }

    const inset = horizontalInset(this.renderer.width);
    if (inset === this.inset) {
      return;
    }

    this.inset = inset;
    this.paddingLeft = inset;
    this.paddingRight = inset;
  };
}
