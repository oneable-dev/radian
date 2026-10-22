import { BoxRenderable, RenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { CommandId } from "../keybindings/commands.ts";
import { reportUnexpected, type ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";
import { halfPageStep } from "./navigation.ts";
import { Clipboard } from "./clipboard.ts";
import { uiTheme } from "./theme.ts";
import { paintText } from "./theme-styles.ts";

export type DialogContent = { title: string; text: string; copy?: boolean };

// Read-only details/help share focus and cleanup behavior, not feature-specific state.
export class TextDialog {
  readonly root: BoxRenderable;
  readonly scroll: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly body: TextRenderable;
  private readonly status: TextRenderable;
  private readonly clipboard: Clipboard;
  private content: DialogContent | undefined;
  private owner: Renderable | undefined;
  private revision = 0;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly changed: () => void,
    private readonly fallback: () => void, private readonly copyText?: (text: string) => Promise<Result<string, ExpectedError>>) {
    const theme = uiTheme(renderer);
    this.clipboard = new Clipboard(renderer);
    this.root = new BoxRenderable(renderer, { id: "text-dialog", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 6000,
      visible: false,
      onMouseDown: (event) => event.stopPropagation(), onMouseScroll: (event) => event.stopPropagation() });
    this.panel = new BoxRenderable(renderer, { id: "text-dialog-panel", position: "absolute", border: true, paddingX: 1,
      flexDirection: "column", minWidth: 0, minHeight: 0 });
    this.title = new TextRenderable(renderer, { id: "text-dialog-title", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.scroll = new ScrollBoxRenderable(renderer, { id: "text-dialog-scroll", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      onMouseDown: () => this.scroll.focus() });
    this.body = new TextRenderable(renderer, { id: "text-dialog-body", width: "100%", wrapMode: "word", selectable: true });
    this.scroll.add(this.body);
    this.status = new TextRenderable(renderer, { id: "text-dialog-status", height: 1, flexShrink: 0, wrapMode: "none", selectable: false, visible: false });
    this.panel.add(this.title); this.panel.add(this.scroll); this.panel.add(this.status); this.root.add(this.panel);
    theme.scrollbars(this.scroll);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      paintText(this.title, styles["ui.popupTitle"]); paintText(this.body, styles["ui.label"]); paintText(this.status, styles["ui.muted"]);
    });
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
    this.root.once(RenderableEvents.DESTROYED, () => this.dispose());
  }

  get visible(): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible; }
  show(content: DialogContent): void {
    if (this.disposed || this.root.isDestroyed) return;
    if (!this.visible) this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.revision++; this.content = content;
    this.title.content = content.title; this.body.content = content.text;
    this.status.visible = false; this.root.visible = true; this.resize(); this.scroll.scrollTo(0); this.scroll.focus(); this.changed();
  }
  hide(): void {
    if (!this.visible) return;
    this.revision++; this.root.visible = false; this.content = undefined;
    const owner = this.owner; this.owner = undefined;
    let restored = false;
    if (owner && !owner.isDestroyed) {
      let visible = true;
      for (let node: Renderable | null = owner; node; node = node.parent as Renderable | null) visible &&= node.visible;
      if (visible) { owner.focus(); restored = this.renderer.currentFocusedRenderable === owner; }
    }
    if (!restored) this.fallback();
    this.changed();
  }
  moveFocus(): void { this.scroll.focus(); }
  command(command: CommandId): void {
    if (!this.visible) return;
    const page = Math.max(1, this.scroll.viewport.height - 1);
    switch (command) {
      case "dialog.dismiss": this.hide(); break;
      case "dialog.copy": this.copy(); break;
      case "dialog.previous": this.scroll.scrollBy(-1); break;
      case "dialog.next": this.scroll.scrollBy(1); break;
      case "dialog.page-up": this.scroll.scrollBy(-page); break;
      case "dialog.page-down": this.scroll.scrollBy(page); break;
      case "dialog.half-page-up": this.scroll.scrollBy(-halfPageStep(this.scroll.viewport.height)); break;
      case "dialog.half-page-down": this.scroll.scrollBy(halfPageStep(this.scroll.viewport.height)); break;
      case "dialog.first": this.scroll.scrollTo(0); break;
      case "dialog.last": this.scroll.scrollTo(Infinity); break;
    }
  }
  private copy(): void {
    const content = this.content, revision = this.revision;
    if (!content || content.copy === false) return;
    void Promise.resolve().then(() => this.copyText?.(content.text) ?? this.clipboard.copy(content.text)).then((result) => {
      if (!this.visible || revision !== this.revision) return;
      this.status.content = result.ok ? result.value : `[${result.error.code}] ${result.error.message}`;
      this.status.visible = true;
    }).catch((error: unknown) => {
      const message = reportUnexpected(error, "dialog copy");
      if (this.visible && revision === this.revision) { this.status.content = message; this.status.visible = true; }
    });
  }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    this.scroll.focus();
  };
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const width = Math.max(1, Math.min(110, this.renderer.width - 4)), height = Math.max(1, Math.min(this.renderer.height - 2, Math.floor(this.renderer.height * 0.85)));
    this.panel.width = width; this.panel.height = height;
    this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.revision++; this.owner = undefined;
    this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus);
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "dialog clipboard cleanup"));
  }
}
