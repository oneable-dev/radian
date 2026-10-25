import { BoxRenderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer } from "@opentui/core";
import { uiTheme, type UiTheme } from "./theme.ts";
import { paintText, styleChunk } from "./theme-styles.ts";
import type { Button } from "./button.ts";
import { singleLine, truncateCells } from "./text.ts";
import { icons } from "../icons.ts";

export type FooterShortcut = { readonly key: string; readonly label: string; readonly disabled?: boolean };
type Scope = { name: string; branch: string | null };

// One stable row: view badge and plain workspace context on the left, contextual hints on the right.
export class Footer {
  readonly root: BoxRenderable;
  readonly bar: BoxRenderable;
  private readonly identity: TextRenderable;
  private readonly hints: TextRenderable;
  private readonly context: TextRenderable;
  private readonly workspace: TextRenderable;
  private contextText = "";
  private viewText = "AGENT";
  private scope: Scope | null = null;
  private shortcuts: readonly FooterShortcut[] = [];
  private helpHint = "";
  private readonly theme: UiTheme;

  constructor(renderer: CliRenderer, private readonly actions?: { help: Button }) {
    this.theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "app-footer", width: "100%", height: 1, flexShrink: 0 });
    this.bar = new BoxRenderable(renderer, { id: "footer-bar", width: "100%", height: 1, flexShrink: 0,
      flexDirection: "row", alignItems: "center", onSizeChange: () => this.render() });
    const text = (id: string) => new TextRenderable(renderer, { id, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.identity = text("footer-identity"); this.context = text("footer-context"); this.hints = text("footer-hints"); this.workspace = text("footer-workspace");
    this.hints.textAlign = "right";
    this.bar.add(this.identity); this.bar.add(this.workspace); this.bar.add(this.context); this.bar.add(this.hints);
    if (actions) { actions.help.id = "footer-help"; this.bar.add(actions.help); }
    this.root.add(this.bar);
    renderer.on("resize", this.render);
    this.root.once(RenderableEvents.DESTROYED, () => renderer.off("resize", this.render));
    this.theme.bindStyles(this.root, () => this.render());
  }
  get focusTargets(): Button[] { return this.actions ? [this.actions.help] : []; }
  setHelpHint(hint: string): void { if (hint !== this.helpHint) { this.helpHint = hint; this.render(); } }
  setView(text: string): void { if (text !== this.viewText) { this.viewText = text; this.render(); } }
  setContext(text: string): void { if (text !== this.contextText) { this.contextText = text; this.render(); } }
  setWorkspace(scope: Scope | null): void { this.scope = scope; this.render(); }
  setShortcuts(shortcuts: readonly FooterShortcut[]): void { this.shortcuts = shortcuts; this.render(); }
  private render = (): void => {
    if (this.root.isDestroyed) return;
    const width = Math.max(0, this.bar.width), styles = this.theme.styles;
    const view = ` ${singleLine(this.viewText).toUpperCase()} `;
    const identityWidth = Math.min(width, Bun.stringWidth(view));
    this.identity.width = identityWidth; this.identity.content = truncateCells(view, identityWidth);
    paintText(this.identity, styles["footer.mode"]); this.bar.backgroundColor = styles["footer.identity"].bg;
    const helpLabel = width < 80 ? /^<F\d+>$/u.test(this.helpHint) ? this.helpHint : "?" : this.helpHint ? `${this.helpHint} Help` : "Help";
    const helpWidth = this.actions ? Math.min(Math.max(0, width - identityWidth), Bun.stringWidth(helpLabel) + 2) : 0;
    if (this.actions) { this.actions.help.setLabel(helpLabel); this.actions.help.visible = helpWidth > 0; this.actions.help.width = helpWidth; }
    let remaining = Math.max(0, width - identityWidth - helpWidth);
    const scopeWidth = this.scope ? Math.min(remaining, Math.floor(width * 0.5)) : 0;
    const worktreePrefix = ` ${icons.folder} `, separator = " · ", branchPrefix = `${icons.branch} `, suffix = " ";
    const overhead = Bun.stringWidth(worktreePrefix + separator + branchPrefix + suffix), budget = scopeWidth - overhead;
    this.workspace.visible = !!this.scope && budget >= 2;
    let workspaceWidth = 0;
    if (this.scope && this.workspace.visible) {
      const name = singleLine(this.scope.name), branch = singleLine(this.scope.branch ?? "detached HEAD");
      const branchBudget = Math.min(Bun.stringWidth(branch), Math.ceil(budget / 2));
      const worktree = truncateCells(name, budget - branchBudget), ref = truncateCells(branch, budget - Bun.stringWidth(worktree));
      const left = worktreePrefix + worktree, right = branchPrefix + ref + suffix;
      workspaceWidth = Bun.stringWidth(left + separator + right);
      this.workspace.content = new StyledText([styleChunk(left, styles["footer.worktree"]), styleChunk(separator, styles["ui.muted"]), styleChunk(right, styles["footer.branch"])]);
    }
    this.workspace.width = workspaceWidth; remaining -= workspaceWidth;
    const context = singleLine(this.contextText), contextWidth = Math.min(Math.max(0, remaining - 2), context ? Bun.stringWidth(context) + 2 : 0);
    this.context.width = contextWidth; this.context.visible = contextWidth > 0;
    this.context.content = truncateCells(` ${context} `, contextWidth); paintText(this.context, styles["footer.accent"]);
    const available = Math.max(0, remaining - contextWidth);
    this.hints.width = available; this.hints.visible = available > 0;
    const chunks = [];
    let used = 0;
    for (const { key, label, disabled } of this.shortcuts) {
      const text = `${key} ${label}`, size = Bun.stringWidth(text) + 2;
      if (used + size > available) { if (available > used) chunks.push(styleChunk("…", styles["footer.description"])); break; }
      chunks.push(styleChunk(`${used ? "  " : ""}${key}`, styles[disabled ? "ui.muted" : "footer.key"]), styleChunk(` ${label}`, styles["footer.description"])); used += size;
    }
    this.hints.content = new StyledText(chunks);
  };
}
