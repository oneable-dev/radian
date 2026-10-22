import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import { uiTheme } from "../ui/theme.ts";
import { paintText } from "../ui/theme-styles.ts";

// Plaintext never enters a renderable text buffer, native input history or a prompt draft.
export class SecretInput extends BoxRenderable {
  private secret = "";
  private caret = 0;
  private readonly mask: TextRenderable;
  constructor(renderer: CliRenderer) {
    super(renderer, { id: "accounts-secret", height: 1, width: "100%", focusable: true });
    this.mask = new TextRenderable(renderer, { content: "Paste or type the credential…", height: 1, width: "100%", selectable: false, wrapMode: "none" }); this.add(this.mask);
    uiTheme(renderer).bindStyles(this, styles => { this.backgroundColor = styles["ui.input"].bg; paintText(this.mask, styles["ui.label"]); });
  }
  get value(): string { return this.secret; }
  clear(): void { this.secret = ""; this.caret = 0; this.paint(); }
  private paint(): void { if (this.mask.isDestroyed) return; this.mask.content = this.secret ? "•".repeat(Math.min(this.secret.length, 100)) : "Paste or type the credential…"; }
  private insert(value: string): void {
    const text = value.replace(/[\r\n\x00-\x1f\x7f]/gu, "");
    this.secret = (this.secret.slice(0, this.caret) + text + this.secret.slice(this.caret)).slice(0, 65536); this.caret = Math.min(this.secret.length, this.caret + text.length); this.paint();
  }
  handlePaste(event: PasteEvent): void { event.preventDefault(); event.stopPropagation(); this.insert(new TextDecoder().decode(event.bytes)); }
  handleKeyPress(key: KeyEvent): boolean {
    if (key.eventType === "release") return false;
    if (key.name === "left") this.caret = Math.max(0, this.caret - 1);
    else if (key.name === "right") this.caret = Math.min(this.secret.length, this.caret + 1);
    else if (key.name === "home" || key.ctrl && key.name === "a") this.caret = 0;
    else if (key.name === "end" || key.ctrl && key.name === "e") this.caret = this.secret.length;
    else if (key.ctrl && ["c", "u"].includes(key.name)) this.clear();
    else if (key.name === "backspace") { if (this.caret) { this.secret = this.secret.slice(0, this.caret - 1) + this.secret.slice(this.caret); this.caret--; } }
    else if (key.name === "delete") this.secret = this.secret.slice(0, this.caret) + this.secret.slice(this.caret + 1);
    else if (!key.ctrl && !key.meta && !key.option && key.sequence && !/[\x00-\x1f\x7f]/u.test(key.sequence)) this.insert(key.sequence);
    else return false;
    key.preventDefault(); key.stopPropagation(); this.paint(); return true;
  }
}
