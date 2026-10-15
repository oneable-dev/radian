import { BoxRenderable, StyledText, TextRenderable, fg, type CliRenderer } from "@opentui/core";

export type FooterShortcut = { readonly key: string; readonly label: string };

const colors = { background: "#111827", identity: "#64748B", label: "#94A3B8", key: "#D87DB7" };

// Presentation only: the owner supplies shortcuts for the actual focus context, not global actions.
export class Footer {
  readonly root: BoxRenderable;
  readonly bar: BoxRenderable;
  readonly notice: TextRenderable;
  private readonly identity: TextRenderable;
  private readonly hints: TextRenderable;
  private shortcuts: readonly FooterShortcut[] = [];
  private lastLayout = "";

  constructor(renderer: CliRenderer, private readonly appIdentity: string) {
    this.root = new BoxRenderable(renderer, { id: "app-footer", width: "100%", height: 2, flexShrink: 0, flexDirection: "column" });
    // Preserve the existing one-row notice allocation, including when empty, to avoid layout jumps.
    this.notice = new TextRenderable(renderer, { id: "footer-notice", width: "100%", height: 1, flexShrink: 0,
      content: "", fg: colors.label, wrapMode: "none", selectable: false });
    this.bar = new BoxRenderable(renderer, { id: "footer-bar", width: "100%", height: 1, flexShrink: 0,
      flexDirection: "row", paddingX: 1, gap: 2, backgroundColor: colors.background, onSizeChange: () => this.renderShortcuts() });
    this.identity = new TextRenderable(renderer, { content: appIdentity, height: 1, flexShrink: 0,
      fg: colors.identity, wrapMode: "none", selectable: false });
    this.hints = new TextRenderable(renderer, { content: "", height: 1, flexShrink: 0,
      textAlign: "right", wrapMode: "none", selectable: false });
    this.bar.add(this.identity); this.bar.add(this.hints);
    this.root.add(this.notice); this.root.add(this.bar);
  }

  setNotice(message: string): void {
    if (!this.root.isDestroyed) this.notice.content = message.replace(/\s+/g, " ");
  }

  setShortcuts(shortcuts: readonly FooterShortcut[]): void {
    if (this.root.isDestroyed) return;
    this.shortcuts = shortcuts;
    this.renderShortcuts();
  }

  private renderShortcuts(): void {
    if (this.root.isDestroyed) return;
    const width = Math.max(0, this.bar.width - 2);
    const identityWidth = Math.min(Bun.stringWidth(this.appIdentity), width);
    const available = Math.max(0, width - identityWidth - 2);
    const signature = JSON.stringify([width, this.shortcuts]);
    if (signature === this.lastLayout) return;
    this.lastLayout = signature;
    this.identity.width = identityWidth;
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
    const chunks = visible.flatMap(({ key, label }, index) => [
      fg(colors.key)(`${index ? "  " : ""}${key}`), fg(colors.label)(` ${label}`),
    ]);
    if (truncated && available > 0) chunks.push(fg(colors.label)(`${visible.length ? "  " : ""}…`));
    this.hints.content = new StyledText(chunks);
  }
}
