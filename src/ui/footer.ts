import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, fg, type CliRenderer } from "@opentui/core";
import { blendColors, uiTheme, type UiTheme } from "./theme.ts";
import { horizontalInset } from "./spacing.ts";

export type FooterShortcut = { readonly key: string; readonly label: string; readonly disabled?: boolean };

// Presentation only: the owner supplies shortcuts for the actual focus context, not global actions.
export class Footer {
  readonly root: BoxRenderable;
  readonly bar: BoxRenderable;
  readonly notice: TextRenderable;
  private readonly identity: TextRenderable;
  private readonly hints: TextRenderable;
  private shortcuts: readonly FooterShortcut[] = [];
  private lastLayout = "";
  private readonly theme: UiTheme;

  constructor(renderer: CliRenderer, private readonly appIdentity: string) {
    this.theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "app-footer", width: "100%", height: 1, flexShrink: 0, flexDirection: "column" });
    this.notice = new TextRenderable(renderer, { id: "footer-notice", width: "100%", height: 1, flexShrink: 0,
      content: "", visible: false, wrapMode: "none", selectable: false });
    this.bar = new BoxRenderable(renderer, { id: "footer-bar", width: "100%", height: 1, flexShrink: 0,
      flexDirection: "row", alignItems: "center", paddingRight: 1, gap: 2, onSizeChange: () => this.renderShortcuts() });
    this.identity = new TextRenderable(renderer, { id: "footer-identity", content: appIdentity, height: 1, flexShrink: 0,
      wrapMode: "none", selectable: false });
    this.hints = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0,
      textAlign: "right", wrapMode: "none", selectable: false });
    this.bar.add(this.identity); this.bar.add(this.hints);
    this.root.add(this.notice); this.root.add(this.bar);
    const resize = () => this.renderShortcuts();
    renderer.on("resize", resize);
    this.root.once(RenderableEvents.DESTROYED, () => renderer.off("resize", resize));
    this.theme.bind(this.root, (colors) => {
      this.notice.fg = colors.muted; this.identity.fg = colors.text; this.bar.backgroundColor = colors.surface;
      this.lastLayout = ""; this.renderShortcuts();
    });
  }

  setNotice(message: string): void {
    if (this.root.isDestroyed) return;
    const content = message.replace(/\s+/g, " ").trim();
    this.notice.content = content;
    this.notice.visible = Boolean(content);
    this.renderShortcuts();
  }

  setShortcuts(shortcuts: readonly FooterShortcut[]): void {
    if (this.root.isDestroyed) return;
    this.shortcuts = shortcuts;
    this.renderShortcuts();
  }

  private renderShortcuts(): void {
    if (this.root.isDestroyed) return;
    this.root.height = 1 + Number(this.notice.visible);
    const inset = horizontalInset(this.bar.width);
    const width = Math.max(0, this.bar.width - inset);
    const textWidth = Bun.stringWidth(this.appIdentity) + inset;
    // Let the fade breathe on wide screens, but give shortcuts their space back on small terminals.
    const identityWidth = Math.min(textWidth + Math.min(8, Math.max(0, width - 60)), width);
    const available = Math.max(0, width - identityWidth - 2);
    const signature = JSON.stringify([width, this.shortcuts]);
    if (signature === this.lastLayout) return;
    this.lastLayout = signature;
    this.bar.paddingRight = inset;
    this.notice.marginLeft = inset; this.notice.width = Math.max(0, this.bar.width - inset * 2);
    this.identity.width = identityWidth;
    this.paintIdentity(identityWidth, inset);
    this.hints.width = available;
    this.hints.visible = available > 0;
    const widths = this.shortcuts.map(({ key, label }) => Bun.stringWidth(`${key} ${label}`));
    const total = widths.reduce((sum, size) => sum + size, 0) + Math.max(0, widths.length - 1) * 2;
    const truncated = total > available;
    const budget = truncated ? Math.max(0, available - 3) : available;
    let used = 0;
    const visible: FooterShortcut[] = [];
    // Keep the owner's order and omit whole trailing hints; never display a partial shortcut/action pair.
    for (const [index, shortcut] of this.shortcuts.entries()) {
      const size = widths[index]! + (visible.length ? 2 : 0);
      if (used + size > budget) break;
      visible.push(shortcut); used += size;
    }
    const colors = this.theme.colors;
    const chunks = visible.flatMap(({ key, label, disabled }, index) => [
      fg(disabled ? colors.muted : colors.keyword)(`${index ? "  " : ""}${key}`), fg(colors.muted)(` ${label}`),
    ]);
    if (truncated && available > 0) chunks.push(fg(colors.muted)(`${visible.length ? "  " : ""}…`));
    this.hints.content = new StyledText(chunks);
  }

  private paintIdentity(width: number, inset: number): void {
    const colors = this.theme.colors;
    const background = (cell: number) => cell < width
      ? blendColors(colors.surface, colors.accent, 0.28 * (1 - cell / Math.max(1, width - 1))) : colors.surface;
    const label = " ".repeat(inset) + this.appIdentity;
    let cell = 0;
    this.identity.content = new StyledText(Array.from(label + " ".repeat(Math.max(0, width - Bun.stringWidth(label))), (text) => {
      const bg = background(cell); cell += Bun.stringWidth(text);
      return { __isChunk: true, text, fg: colors.text, bg };
    }));
  }
}
