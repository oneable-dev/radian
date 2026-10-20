import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import { blendColors, uiTheme, type UiTheme } from "./theme.ts";
import { paintText, styleChunk } from "./theme-styles.ts";
import { horizontalInset } from "./spacing.ts";
import type { Button } from "./button.ts";
import { singleLine, truncateCells } from "./text.ts";

export type FooterShortcut = { readonly key: string; readonly label: string; readonly disabled?: boolean };
type Actions = { help: Button; details: Button };

// Presentation only: shortcuts and actions come from the actual owner/focus context.
export class Footer {
  readonly root: BoxRenderable;
  readonly bar: BoxRenderable;
  readonly notice: TextRenderable;
  private readonly noticeRow: BoxRenderable;
  private readonly identity: TextRenderable;
  private readonly hints: TextRenderable;
  private readonly context: TextRenderable;
  private contextText = "";
  private viewText = "";
  private shortcuts: readonly FooterShortcut[] = [];
  private lastLayout = "";
  private message = "";
  private helpHint = "";
  private readonly theme: UiTheme;

  constructor(renderer: CliRenderer, private readonly appIdentity: string, private readonly actions?: Actions,
    private readonly compactIdentity = appIdentity) {
    this.theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "app-footer", width: "100%", height: 1, flexShrink: 0, flexDirection: "column" });
    this.noticeRow = new BoxRenderable(renderer, { id: "footer-notice-row", width: "100%", height: 1, flexShrink: 0, flexDirection: "row", visible: false });
    this.notice = new TextRenderable(renderer, { id: "footer-notice", height: 1, flexShrink: 0,
      content: "", visible: false, wrapMode: "none", selectable: false });
    this.noticeRow.add(this.notice);
    if (actions) { actions.details.id = "footer-notice-details"; this.noticeRow.add(actions.details); }
    this.bar = new BoxRenderable(renderer, { id: "footer-bar", width: "100%", height: 1, flexShrink: 0,
      flexDirection: "row", alignItems: "center", paddingRight: 1, gap: 2, onSizeChange: () => this.renderShortcuts() });
    this.identity = new TextRenderable(renderer, { id: "footer-identity", content: appIdentity, height: 1, flexShrink: 0,
      wrapMode: "none", selectable: false });
    this.hints = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0,
      textAlign: "right", wrapMode: "none", selectable: false });
    this.context = new TextRenderable(renderer, { id: "footer-context", content: "", height: 1, flexShrink: 0,
      wrapMode: "none", selectable: false, visible: false });
    this.bar.add(this.identity); this.bar.add(this.context); this.bar.add(this.hints);
    if (actions) { actions.help.id = "footer-help"; this.bar.add(actions.help); }
    this.root.add(this.noticeRow); this.root.add(this.bar);
    const resize = () => this.renderShortcuts();
    renderer.on("resize", resize);
    this.root.once(RenderableEvents.DESTROYED, () => renderer.off("resize", resize));
    this.theme.bindStyles(this.root, (styles) => {
      paintText(this.notice, styles["footer.description"]); paintText(this.identity, styles["footer.identity"]);
      paintText(this.context, styles["footer.accent"]); this.bar.backgroundColor = styles["footer.identity"].bg;
      this.lastLayout = ""; this.renderShortcuts();
    });
  }

  get noticeText(): string { return this.message; }
  get focusTargets(): Button[] { return this.actions ? [...(this.notice.visible ? [this.actions.details] : []), this.actions.help] : []; }
  setNotice(message: string): void {
    if (this.root.isDestroyed) return;
    this.message = message;
    this.notice.visible = this.noticeRow.visible = Boolean(message.trim());
    this.lastLayout = ""; this.renderShortcuts();
  }
  setHelpHint(hint: string): void {
    if (hint === this.helpHint) return;
    this.helpHint = hint; this.lastLayout = ""; this.renderShortcuts();
  }
  setView(text: string): void {
    if (this.root.isDestroyed || text === this.viewText) return;
    this.viewText = text; this.lastLayout = ""; this.renderShortcuts();
  }
  setContext(text: string): void {
    if (this.root.isDestroyed || text === this.contextText) return;
    this.contextText = text; this.lastLayout = ""; this.renderShortcuts();
  }
  setShortcuts(shortcuts: readonly FooterShortcut[]): void {
    if (this.root.isDestroyed) return;
    this.shortcuts = shortcuts; this.renderShortcuts();
  }
  private renderShortcuts(): void {
    if (this.root.isDestroyed) return;
    this.root.height = 1 + Number(this.notice.visible);
    const inset = horizontalInset(this.bar.width), width = Math.max(0, this.bar.width - inset * 2);
    const helpLabel = this.helpHint ? `${this.helpHint} Help` : "Help";
    // Keep the help entry discoverable; its full configured key is inside the popup on narrow screens.
    const compactHelp = this.bar.width < 80 ? /^f\d+$/iu.test(this.helpHint) ? this.helpHint.toUpperCase() : "?" : helpLabel;
    const helpWidth = this.actions ? Bun.stringWidth(compactHelp) + 2 : 0;
    const view = singleLine(this.viewText);
    const identityLimit = view ? Math.max(0, width - (this.actions ? helpWidth + 2 : 0)) : width;
    let identity = view && this.bar.width < 80 ? this.compactIdentity : this.appIdentity;
    if (view && Bun.stringWidth(`${identity} · ${view}`) > identityLimit) identity = this.compactIdentity;
    if (view && Bun.stringWidth(`${identity} · ${view}`) > identityLimit) identity = "";
    const label = (identity ? identity + (view ? " · " : "") : "") + view;
    const textWidth = Bun.stringWidth(label);
    const identityWidth = Math.min(textWidth + Math.min(8, Math.max(0, width - 60)), identityLimit);
    const remaining = Math.max(0, width - identityWidth - (this.actions ? helpWidth + 4 : 2));
    const context = singleLine(this.contextText), contextWidth = Math.min(Bun.stringWidth(context), Math.max(0, remaining - 2));
    const available = Math.max(0, remaining - contextWidth - (contextWidth ? 2 : 0));
    const signature = JSON.stringify([width, this.shortcuts, this.helpHint, this.message, this.contextText, this.viewText]);
    if (signature === this.lastLayout) return;
    this.lastLayout = signature;
    this.bar.paddingRight = inset;
    this.identity.width = identityWidth + inset;
    this.paintIdentity(identityWidth + inset, inset, identity, view);
    if (this.actions) {
      this.actions.help.setLabel(compactHelp);
      this.actions.details.setLabel("Details");
    }
    const noticeWidth = Math.max(0, this.bar.width - inset * 2 - (this.actions ? 9 : 0));
    this.noticeRow.paddingLeft = inset; this.noticeRow.paddingRight = inset;
    this.notice.width = noticeWidth;
    const summary = this.message.split(/\r?\n/u).find((line) => line.trim()) ?? "";
    this.notice.content = truncateCells(singleLine(summary), noticeWidth);
    this.context.width = contextWidth; this.context.visible = contextWidth > 0;
    this.context.content = truncateCells(context, contextWidth);
    this.hints.width = available; this.hints.visible = available > 0;
    const gap = this.bar.width < 80 ? 1 : 2;
    const widths = this.shortcuts.map(({ key, label }) => Bun.stringWidth(`${key} ${label}`));
    const total = widths.reduce((sum, size) => sum + size, 0) + Math.max(0, widths.length - 1) * gap;
    const truncated = total > available, budget = truncated ? Math.max(0, available - gap - 1) : available;
    let used = 0;
    const visible: FooterShortcut[] = [];
    for (const [index, shortcut] of this.shortcuts.entries()) {
      const size = widths[index]! + (visible.length ? gap : 0);
      if (used + size > budget) break;
      visible.push(shortcut); used += size;
    }
    const styles = this.theme.styles;
    const chunks = visible.flatMap(({ key, label, disabled }, index) => [
      styleChunk(`${" ".repeat(index ? gap : 0)}${key}`, styles[disabled ? "footer.description" : "footer.key"]),
      styleChunk(` ${label}`, styles["footer.description"]),
    ]);
    if (truncated && available > 0) chunks.push(styleChunk(`${" ".repeat(visible.length ? gap : 0)}…`, styles["footer.description"]));
    this.hints.content = new StyledText(chunks);
  }
  private paintIdentity(width: number, inset: number, identity: string, view: string): void {
    const colors = this.theme.colors, styles = this.theme.styles;
    const surface = styles["footer.identity"].bg ?? colors.surface;
    const background = (cell: number) => this.theme.monochrome ? colors.panel : cell < width
      ? blendColors(surface, styles["footer.accent"].fg, 0.28 * (1 - cell / Math.max(1, width - 1))) : surface;
    const prefix = " ".repeat(inset) + identity + (identity && view ? " · " : "");
    const viewStart = Bun.stringWidth(prefix), viewEnd = viewStart + Bun.stringWidth(view);
    const label = truncateCells(prefix + view, width);
    let cell = 0;
    this.identity.content = new StyledText(Array.from(label + " ".repeat(Math.max(0, width - Bun.stringWidth(label))), (text) => {
      const bg = background(cell), accent = cell >= viewStart && cell < viewEnd;
      cell += Bun.stringWidth(text);
      return { ...styleChunk(text, styles[accent ? "footer.accent" : "footer.identity"]), bg };
    }));
  }
}
