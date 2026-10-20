import { BoxRenderable, RenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { ExpectedError, reportUnexpected } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { PtyFrame, TerminalInfo } from "../../runtime/protocol.ts";
import type { Worktree } from "../../workspace/model.ts";
import { TerminalSurface, type PtyAttachment } from "../../ui/embedded-terminal/surface.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import { uiTheme } from "../../ui/theme.ts";
import type { Button, ButtonFactory } from "../../ui/button.ts";
import { bindPanelSpacing } from "../../ui/spacing.ts";
import type { TerminalTitles } from "../process-titles.ts";

export type TerminalActions = {
  list(): readonly TerminalInfo[];
  titles?(items: readonly TerminalInfo[], signal: AbortSignal): Promise<Result<TerminalTitles, ExpectedError>>;
  create(worktreeId: string, size: { cols: number; rows: number }): Promise<Result<string, ExpectedError>>;
  attach(id: string, frame: (frame: PtyFrame) => void, failed: (error: unknown) => void): Promise<Result<PtyAttachment, ExpectedError>>;
  close(id: string): Promise<Result<void, ExpectedError>>;
};
export class TerminalPanel {
  readonly root: BoxRenderable;
  private readonly tabs: ScrollBoxRenderable;
  private readonly message: TextRenderable;
  private readonly messageRow: BoxRenderable;
  private readonly viewport: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly newButton: BoxRenderable;
  private readonly closeButton: BoxRenderable;
  private readonly reconnectButton: BoxRenderable;
  private readonly tabButtons = new Map<string, Button>();
  private readonly creating = new Set<string>();
  private worktree: Worktree | null = null;
  private items: readonly TerminalInfo[] = [];
  private selected: string | undefined;
  private tabKey = "";
  private pendingTabScroll = false;
  private generation = 0;
  private intent = 0;
  private disposed = false;
  private connection: PtyAttachment | undefined;
  private surface: TerminalSurface | undefined;
  private task: Promise<void> = Promise.resolve();
  private cancelLayout: (() => void) | undefined;
  private readonly processNames = new Map<string, string>();
  private titleScope = "";
  private titleTimer: ReturnType<CliRenderer["clock"]["setTimeout"]> | undefined;
  private titleAbort: AbortController | undefined;
  private titleWarning = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: TerminalActions | undefined,
    private readonly button: ButtonFactory, private readonly notice: (message: string) => void,
    private readonly selectionChanged: (worktreeId: string, id: string | null) => void, private readonly changed: () => void, private readonly unavailable?: string, private readonly terminalTheme?: TerminalTheme) {
    this.root = new BoxRenderable(renderer, { id: "terminal-view", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false });
    const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.tabs = new ScrollBoxRenderable(renderer, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, scrollX: true, scrollY: false,
      contentOptions: { flexDirection: "row", gap: 1 }, horizontalScrollbarOptions: { visible: false },
      onSizeChange: () => { this.pendingTabScroll = true; this.renderer.requestRender(); } });
    this.newButton = button("+ New", () => this.create(), "New terminal");
    this.closeButton = button("Close", () => this.closeSelected(), "Close terminal");
    this.reconnectButton = button("Reconnect", () => { this.intent++; this.activate(this.selected, true); }, "Reconnect terminal");
    this.reconnectButton.visible = false;
    toolbar.add(this.tabs); toolbar.add(this.newButton); toolbar.add(this.closeButton); toolbar.add(this.reconnectButton);
    const status = this.messageRow = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", visible: false });
    this.message = new TextRenderable(renderer, { content: "", flexGrow: 1, minWidth: 0, height: 1, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "terminal-spinner" });
    uiTheme(renderer).bind(this.message, (colors) => { this.message.fg = colors.muted; });
    uiTheme(renderer).bind(this.spinner.root, (colors) => { this.spinner.root.fg = colors.accent; });
    uiTheme(renderer).scrollbars(this.tabs);
    const activity = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    activity.add(this.spinner.root); toolbar.add(activity);
    status.add(this.message);
    this.viewport = new BoxRenderable(renderer, { id: "terminal-viewport", flexGrow: 1, minHeight: 0, flexDirection: "column" });
    this.root.add(toolbar); this.root.add(status); this.root.add(this.viewport);
    bindPanelSpacing(renderer, this.root);
    this.root.once(RenderableEvents.DESTROYED, () => this.stopTitles());
    renderer.on("frame", this.revealSelected);
  }
  get input(): Renderable | undefined { return this.surface?.root; }
  get canClose(): boolean { return !!this.selected && !!this.actions; }
  get canScroll(): boolean { return this.surface?.canScroll ?? false; }
  get focusTargets(): Renderable[] {
    return [...this.tabButtons.values(), this.newButton, this.closeButton, this.reconnectButton, ...(this.input ? [this.input] : [])].filter((item) => item.visible);
  }
  show(worktree: Worktree | null, remembered?: string): void {
    if (this.disposed || this.root.isDestroyed) return;
    const same = this.root.visible && this.worktree?.id === worktree?.id;
    if (!same) { this.intent++; this.pendingTabScroll = true; }
    const oldIndex = same ? this.items.findIndex((item) => item.id === this.selected) : 0;
    this.worktree = worktree; this.root.visible = true;
    this.items = this.actions?.list().filter((item) => item.worktreeId === worktree?.id) ?? [];
    const selected = this.items.find((item) => item.id === remembered)?.id ?? this.items[Math.max(0, Math.min(oldIndex, this.items.length - 1))]?.id;
    const focus = Boolean(this.surface?.root.focused);
    if (!same || selected !== this.selected) this.activate(selected, focus);
    if (worktree && selected !== remembered) this.selectionChanged(worktree.id, selected ?? null);
    const info = this.items.find((item) => item.id === selected);
    if (this.surface) this.surface.acceptsInput = !info?.exited;
    this.paintTabs();
    if (!this.actions) this.setMessage(this.unavailable ?? "Terminal preview · no shells run in demo mode.");
    else if (!worktree) this.setMessage("Select a workspace to use terminals.");
    else if (!selected) this.setMessage("No terminals · create one explicitly.");
    else if (!this.reconnectButton.visible) this.setMessage("");
    this.refreshTitles();
    this.newButton.visible = Boolean(worktree && this.actions);
    this.closeButton.visible = Boolean(selected && this.actions);
  }
  private paintTabs(): void {
    const key = JSON.stringify([this.selected, this.items.map((item) => [item.id, this.processName(item), item.exited])]);
    if (key === this.tabKey) return;
    this.tabKey = key;
    const focused = this.renderer.currentFocusedRenderable;
    const ids = new Set(this.items.map((item) => item.id));
    for (const id of this.tabButtons.keys()) if (!ids.has(id)) {
      this.tabs.getChildren().find((child) => child.id === `terminal-tab:${id}`)?.destroyRecursively();
      this.tabButtons.delete(id); this.processNames.delete(id);
    }
    for (const [index, item] of this.items.entries()) {
      let tab = this.tabButtons.get(item.id);
      if (!tab) {
        const wrapper = new BoxRenderable(this.renderer, { id: `terminal-tab:${item.id}`, height: 1, flexShrink: 0 });
        tab = this.button("", () => { this.intent++; if (this.worktree) this.selectionChanged(this.worktree.id, item.id); this.activate(item.id, true); this.paintTabs(); }, "Select terminal", "session-tab");
        this.tabButtons.set(item.id, tab); wrapper.add(tab); this.tabs.add(wrapper);
      }
      tab.setLabel(`${this.processName(item)}${item.exited ? " (exited)" : ""}`);
      tab.active = item.id === this.selected;
      const wrapper = this.tabs.getChildren().find((child) => child.id === `terminal-tab:${item.id}`)!;
      if (this.tabs.getChildren()[index] !== wrapper) this.tabs.add(wrapper, index);
    }
    if (this.selected) {
      this.pendingTabScroll = true; this.renderer.requestRender();
      if (focused?.isDestroyed) this.tabButtons.get(this.selected)?.focus();
    }
  }
  private revealSelected = (): void => {
    if (!this.pendingTabScroll || this.disposed || this.root.isDestroyed || !this.root.visible || !this.selected) return;
    this.pendingTabScroll = false; this.tabs.scrollChildIntoView(`terminal-tab:${this.selected}`);
  };
  next(direction: 1 | -1): void {
    if (!this.items.length || !this.worktree) return;
    this.intent++;
    const index = this.items.findIndex((item) => item.id === this.selected);
    const item = this.items[(index + direction + this.items.length) % this.items.length]!;
    this.selectionChanged(this.worktree.id, item.id); this.activate(item.id, true); this.paintTabs();
  }
  scroll(direction: 1 | -1): void { this.surface?.scroll(direction * Math.max(1, (this.surface.root.height || 10) - 1)); }
  create(): void {
    const worktree = this.worktree, actions = this.actions;
    if (!worktree || !actions || this.creating.has(worktree.id)) return;
    const intent = this.intent;
    const current = () => !this.disposed && !this.root.isDestroyed && this.root.visible && this.worktree?.id === worktree.id && this.intent === intent;
    this.creating.add(worktree.id); this.spinner.start();
    let handedOff = false;
    void (async () => {
      await this.laidOut();
      if (!current()) return;
      const result = await actions.create(worktree.id, { cols: Math.max(2, Math.min(500, this.viewport.width)), rows: Math.max(1, Math.min(200, this.viewport.height)) });
      if (!current()) return;
      if (!result.ok) { this.failure(result.error); return; }
      this.selectionChanged(worktree.id, result.value);
      this.show(worktree, result.value); this.activate(result.value, true); handedOff = true;
    })().catch((error: unknown) => { if (current()) this.failure(error); else reportUnexpected(error, "terminal creation"); })
      .finally(() => { this.creating.delete(worktree.id); if (!handedOff && current()) this.spinner.stop(); });
  }
  closeSelected(): void {
    if (!this.selected || !this.actions) return;
    this.intent++;
    void this.actions.close(this.selected).then((result) => { if (!result.ok && !this.disposed) this.failure(result.error); })
      .catch((error: unknown) => { if (!this.disposed) this.failure(error); else reportUnexpected(error, "terminal close"); });
  }
  private activate(id: string | undefined, focus: boolean): void {
    this.selected = id; const generation = ++this.generation;
    this.setMessage("");
    this.cancelLayout?.(); this.removeSurface(); this.reconnectButton.visible = false;
    if (!id || !this.actions) {
      this.task = this.task.then(() => this.detach()).catch((error: unknown) => { reportUnexpected(error, "terminal detach"); });
      this.spinner.cancel(); if (focus) this.newButton.focus(); return;
    }
    this.spinner.start();
    this.task = this.task.then(async () => {
      await this.detach(); if (!this.current(generation)) return;
      const surface = new TerminalSurface(this.renderer, "shell-terminal", this.terminalTheme); this.surface = surface; this.viewport.add(surface.root);
      const attached = await this.actions!.attach(id, (frame) => {
        if (!this.current(generation) || surface.root.isDestroyed) return;
        surface.display(frame); surface.acceptsInput = !frame.exited;
        this.setMessage(frame.exited ? `Terminal exited (${frame.exitCode ?? "signal"})` : "");
        this.changed();
      }, (error) => { if (this.current(generation)) this.failure(error); });
      if (!attached.ok) { if (this.current(generation)) this.failure(attached.error); return; }
      if (!this.current(generation) || surface.root.isDestroyed) { await attached.value.disconnect(); return; }
      this.connection = attached.value; surface.connect(attached.value);
      if (focus) surface.root.focus(); this.changed();
    }).catch((error: unknown) => { if (this.current(generation)) this.failure(error); else reportUnexpected(error, "terminal attachment"); })
      .finally(() => { if (this.current(generation)) this.spinner.stop(); });
  }
  private current(generation: number): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && this.generation === generation; }
  private failure(error: unknown): void {
    const message = error instanceof ExpectedError ? `[${error.code}] ${error.message}` : reportUnexpected(error, "terminal view");
    if (this.root.isDestroyed) return;
    this.setMessage("Terminal unavailable · reconnect explicitly"); this.reconnectButton.visible = Boolean(this.selected);
    if (this.surface?.root.focused) this.reconnectButton.focus();
    this.removeSurface(); this.notice(message); this.changed();
  }
  private setMessage(text: string): void { this.message.content = text; this.messageRow.visible = Boolean(text); }
  private processName(item: TerminalInfo): string {
    return this.processNames.get(item.id) ?? item.title.replace(/^Terminal \d+ · /u, "");
  }
  private refreshTitles(): void {
    const scope = JSON.stringify(this.items.map((item) => [item.id, item.pid, item.shellPid]));
    if (scope !== this.titleScope) { this.stopTitles(); this.titleScope = scope; this.titleWarning = false; }
    if (this.disposed || this.root.isDestroyed || !this.actions?.titles || !this.root.visible || !this.items.length || this.titleAbort || this.titleTimer !== undefined) return;
    void this.lookupTitles(scope);
  }
  private async lookupTitles(scope: string): Promise<void> {
    const provider = this.actions?.titles; if (!provider) return;
    const abort = new AbortController(); this.titleAbort = abort;
    const current = () => !this.disposed && !this.root.isDestroyed && this.root.visible && this.titleAbort === abort && this.titleScope === scope;
    try {
      const result = await provider([...this.items], abort.signal);
      if (!current()) return;
      if (result.ok) {
        for (const item of this.items) {
          const title = result.value[item.id];
          if (title) this.processNames.set(item.id, title);
        }
        this.titleWarning = false; this.paintTabs();
      } else if (!this.titleWarning) {
        this.titleWarning = true; this.notice(`[${result.error.code}] Process names unavailable; terminal input is unaffected. ${result.error.message}`);
      }
    } catch (error) { reportUnexpected(error, "terminal process titles"); }
    finally {
      if (current()) {
        this.titleAbort = undefined;
        this.titleTimer = this.renderer.clock.setTimeout(() => { this.titleTimer = undefined; this.refreshTitles(); }, 750);
      }
    }
  }
  private stopTitles(): void {
    if (this.titleTimer !== undefined) this.renderer.clock.clearTimeout(this.titleTimer);
    this.titleTimer = undefined; this.titleAbort?.abort(); this.titleAbort = undefined;
  }
  private laidOut(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.renderer.off("frame", done); this.cancelLayout = undefined; resolve(); };
      this.cancelLayout = done; this.renderer.once("frame", done); this.renderer.requestRender();
    });
  }
  private removeSurface(): void { this.surface?.dispose(); this.surface = undefined; }
  private async detach(): Promise<void> { const connection = this.connection; this.connection = undefined; await connection?.disconnect(); }
  hide(): void {
    if (!this.root.visible) return;
    if (this.surface && !this.surface.root.isDestroyed) this.surface.root.blur();
    this.generation++; this.intent++; this.cancelLayout?.(); this.spinner.cancel(); this.stopTitles(); this.worktree = null; this.selected = undefined;
    if (!this.root.isDestroyed) this.root.visible = false;
    this.removeSurface(); this.task = this.task.then(() => this.detach()).catch((error: unknown) => { reportUnexpected(error, "terminal detach"); });
  }
  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.disposed = true; this.renderer.off("frame", this.revealSelected);
  }
}
