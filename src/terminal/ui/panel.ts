import { BoxRenderable, RenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { ExpectedError, reportUnexpected } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { PtyFrame, TerminalInfo } from "../../runtime/protocol.ts";
import type { Worktree } from "../../workspace/model.ts";
import { TerminalSurface, type PtyAttachment } from "../../ui/embedded-terminal/surface.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { EmptyState } from "../../ui/empty-state.ts";
import type { TerminalTheme } from "../../ui/embedded-terminal/theme.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";
import type { ButtonFactory } from "../../ui/button.ts";
import { SessionTab } from "../../ui/session-tab.ts";
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
  private readonly emptyState: EmptyState;
  private readonly reconnectButton: BoxRenderable;
  private readonly tabButtons = new Map<string, SessionTab>();
  private readonly creating = new Set<string>();
  private defaultRequest: string | undefined;
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
    private readonly selectionChanged: (worktreeId: string, id: string | null) => void, private readonly changed: () => void, private readonly unavailable?: string, private readonly terminalTheme?: TerminalTheme, private readonly creationHint: () => string = () => "") {
    this.root = new BoxRenderable(renderer, { id: "terminal-view", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false, focusable: true });
    const toolbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.tabs = new ScrollBoxRenderable(renderer, { height: 1, flexGrow: 1, flexShrink: 1, minWidth: 0, scrollX: true, scrollY: false,
      contentOptions: { flexDirection: "row", gap: 1 }, horizontalScrollbarOptions: { visible: false },
      onSizeChange: () => { this.resizeTabs(); this.pendingTabScroll = true; this.renderer.requestRender(); } });
    this.reconnectButton = button("Reconnect", () => { this.intent++; this.activate(this.selected, true); }, "Reconnect terminal");
    this.reconnectButton.visible = false;
    toolbar.add(this.tabs); toolbar.add(this.reconnectButton);
    const status = this.messageRow = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", visible: false });
    this.message = new TextRenderable(renderer, { content: "", flexGrow: 1, minWidth: 0, height: 1, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "terminal-spinner" });
    uiTheme(renderer).bindStyles(this.message, (styles) => paintText(this.message, styles["ui.muted"]));
    uiTheme(renderer).bindStyles(this.spinner.root, (styles) => paintText(this.spinner.root, styles["status.working"]));
    uiTheme(renderer).scrollbars(this.tabs);
    const activity = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0 });
    activity.add(this.spinner.root); toolbar.add(activity);
    status.add(this.message);
    this.viewport = new BoxRenderable(renderer, { id: "terminal-viewport", flexGrow: 1, minHeight: 0, flexDirection: "column" });
    this.emptyState = new EmptyState(renderer, "terminal-empty-state"); this.emptyState.root.visible = false;
    this.viewport.add(this.emptyState.root);
    this.root.add(toolbar); this.root.add(status); this.root.add(this.viewport);
    bindPanelSpacing(renderer, this.root);
    this.root.once(RenderableEvents.DESTROYED, () => this.stopTitles());
    renderer.on("frame", this.revealSelected);
  }
  get input(): Renderable | undefined { return this.surface?.root; }
  get canClose(): boolean { return !!this.selected && !!this.actions; }
  get canScroll(): boolean { return this.surface?.canScroll ?? false; }
  get tabsFocused(): boolean { return this.root.visible && [...this.tabButtons.values()].some(tab => tab.root.focused); }
  get focusTargets(): Renderable[] {
    const tabs = [...this.tabButtons.values()].map(tab => tab.root);
    const targets = [...tabs, this.reconnectButton, ...(this.input ? [this.input] : [])].filter(item => item.visible);
    return targets.length ? targets : [this.root];
  }
  show(worktree: Worktree | null, remembered?: string): void {
    if (this.disposed || this.root.isDestroyed) return;
    const same = this.root.visible && this.worktree?.id === worktree?.id;
    if (!same) { this.intent++; this.pendingTabScroll = true; }
    const oldIndex = same ? this.items.findIndex((item) => item.id === this.selected) : 0;
    this.worktree = worktree; this.root.visible = true;
    this.items = this.actions?.list().filter((item) => item.worktreeId === worktree?.id) ?? [];
    const selected = this.items.find((item) => item.id === remembered)?.id ?? this.items[Math.max(0, Math.min(oldIndex, this.items.length - 1))]?.id;
    const focus = Boolean(this.surface?.root.focused || this.root.focused);
    if (!same || selected !== this.selected) this.activate(selected, focus);
    if (worktree && selected !== remembered) this.selectionChanged(worktree.id, selected ?? null);
    const info = this.items.find((item) => item.id === selected);
    if (this.surface) this.surface.acceptsInput = !info?.exited;
    this.paintTabs();
    if (!this.actions) this.setMessage(this.unavailable ?? "Terminal preview · no shells run in demo mode.");
    else if (!worktree) this.setMessage("Select a workspace to use terminals.");
    else if (!selected) this.setMessage("");
    else if (!this.reconnectButton.visible) this.setMessage("");
    this.refreshTitles();
    // Only entering an empty view starts a shell; exit/close updates must stay empty.
    if (!same && worktree && this.actions && !this.items.length) this.defaultRequest = worktree.id;
    this.createDefault(); this.updateEmptyState();
  }
  private createDefault(): void {
    const worktree = this.worktree;
    if (!worktree || this.defaultRequest !== worktree.id || this.creating.has(worktree.id)) return;
    this.defaultRequest = undefined;
    if (!this.actions?.list().some(item => item.worktreeId === worktree.id)) this.create();
  }
  private updateEmptyState(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const worktree = this.worktree, key = this.creationHint();
    this.emptyState.update({ icon: ">_", title: "No terminals", ...(key ? { action: { key, label: "New terminal" } } : {}) });
    this.emptyState.root.visible = Boolean(this.root.visible && this.actions && worktree && !this.selected && !this.creating.has(worktree.id));
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
        tab = new SessionTab(this.renderer, { id: `terminal-session:${item.id}`, closeId: `close-terminal:${item.id}`,
          closeLabel: "Close terminal", focusable: true, button: this.button,
          select: () => { this.intent++; if (this.worktree) this.selectionChanged(this.worktree.id, item.id); this.activate(item.id, true); this.paintTabs(); },
          close: () => this.close(item.id) });
        this.tabButtons.set(item.id, tab); wrapper.add(tab.root); this.tabs.add(wrapper);
      }
      tab.resize(this.tabs.width);
      tab.setLabel(`${this.processName(item)}${item.exited ? " (exited)" : ""}`);
      tab.update(item.id === this.selected);
      const wrapper = this.tabs.getChildren().find((child) => child.id === `terminal-tab:${item.id}`)!;
      if (this.tabs.getChildren()[index] !== wrapper) this.tabs.add(wrapper, index);
    }
    if (this.selected) {
      this.pendingTabScroll = true; this.renderer.requestRender();
      if (focused?.isDestroyed) this.tabButtons.get(this.selected)?.root.focus();
    } else if (focused?.isDestroyed) this.root.focus();
  }
  private resizeTabs(): void {
    for (const tab of this.tabButtons.values()) tab.resize(this.tabs.width);
  }
  openFocusedTab(): void {
    const index = this.items.findIndex(item => this.tabButtons.get(item.id)?.root.focused);
    if (index >= 0) this.select(index);
  }
  private revealSelected = (): void => {
    if (!this.pendingTabScroll || this.disposed || this.root.isDestroyed || !this.root.visible || !this.selected) return;
    this.pendingTabScroll = false; this.tabs.scrollChildIntoView(`terminal-tab:${this.selected}`);
  };
  focus(): void {
    if (!this.root.visible || this.disposed) return;
    const target = this.input ?? (this.reconnectButton.visible ? this.reconnectButton : this.tabButtons.get(this.selected ?? "")?.root ?? this.root);
    target.focus();
    if (this.input || !this.selected) return;
    const generation = this.generation;
    // A slow attachment may focus its input only if the user has not moved elsewhere.
    void this.task.then(() => {
      if (this.current(generation) && this.renderer.currentFocusedRenderable === target) this.input?.focus();
    });
  }
  canSelect(index: number): boolean { return this.root.visible && !!this.items[index]; }
  select(index: number, focusInput = true): void {
    const item = this.items[index];
    if (!this.root.visible || !item || !this.worktree) return;
    this.intent++;
    if (item.id === this.selected) {
      if (focusInput) this.focus(); else this.tabButtons.get(item.id)?.root.focus();
      return;
    }
    this.selectionChanged(this.worktree.id, item.id); this.activate(item.id, focusInput); this.paintTabs();
    if (!focusInput) this.tabButtons.get(item.id)?.root.focus();
  }
  moveTab(direction: 1 | -1): void {
    if (!this.tabsFocused || !this.items.length) return;
    const index = this.items.findIndex(item => this.tabButtons.get(item.id)?.root.focused);
    this.select(Math.max(0, Math.min(this.items.length - 1, index + direction)), false);
  }
  next(direction: 1 | -1): void {
    if (!this.items.length) return;
    const index = this.items.findIndex((item) => item.id === this.selected);
    this.select((index + direction + this.items.length) % this.items.length);
  }
  scroll(direction: 1 | -1): void { this.surface?.scroll(direction * Math.max(1, (this.surface.root.height || 10) - 1)); }
  create(): void {
    const worktree = this.worktree, actions = this.actions;
    if (!worktree || !actions || this.creating.has(worktree.id)) return;
    const intent = this.intent, owner = this.renderer.currentFocusedRenderable;
    const current = () => !this.disposed && !this.root.isDestroyed && this.root.visible && this.worktree?.id === worktree.id && this.intent === intent;
    this.creating.add(worktree.id); this.updateEmptyState(); this.spinner.start();
    let handedOff = false;
    void (async () => {
      await this.laidOut();
      if (!current()) return;
      // Entering an empty view focuses its root after show(); popups must keep their own focus.
      const focusOwner = this.root.focused ? this.root : owner;
      const result = await actions.create(worktree.id, { cols: Math.max(2, Math.min(500, this.viewport.width)), rows: Math.max(1, Math.min(200, this.viewport.height)) });
      if (!current()) return;
      if (!result.ok) { this.failure(result.error); return; }
      const focus = this.renderer.currentFocusedRenderable === focusOwner;
      this.selectionChanged(worktree.id, result.value);
      this.show(worktree, result.value); this.activate(result.value, focus); handedOff = true;
    })().catch((error: unknown) => { if (current()) this.failure(error); else reportUnexpected(error, "terminal creation"); })
      .finally(() => { this.creating.delete(worktree.id); if (!handedOff && current()) this.spinner.stop(); this.createDefault(); this.updateEmptyState(); });
  }
  closeSelected(): void { if (this.selected) this.close(this.selected); }
  private close(id: string): void {
    if (!this.actions) return;
    if (id === this.selected) this.intent++;
    void this.actions.close(id).then(result => {
      if (!result.ok && !this.disposed) {
        this.notice(`[${result.error.code}] Terminal could not be closed. ${result.error.message}`); this.changed();
      }
    }).catch((error: unknown) => {
      const message = reportUnexpected(error, "terminal close");
      if (!this.disposed) this.notice(message);
    });
  }
  private activate(id: string | undefined, focus: boolean): void {
    this.selected = id; const generation = ++this.generation;
    this.setMessage("");
    this.cancelLayout?.(); this.removeSurface(); this.reconnectButton.visible = false;
    if (!id || !this.actions) {
      this.task = this.task.then(() => this.detach()).catch((error: unknown) => { reportUnexpected(error, "terminal detach"); });
      this.spinner.cancel(); if (focus) this.root.focus(); return;
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
    this.generation++; this.intent++; this.cancelLayout?.(); this.spinner.cancel(); this.stopTitles(); this.worktree = null; this.selected = undefined; this.defaultRequest = undefined;
    if (!this.root.isDestroyed) { this.root.visible = false; this.emptyState.root.visible = false; }
    this.removeSurface(); this.task = this.task.then(() => this.detach()).catch((error: unknown) => { reportUnexpected(error, "terminal detach"); });
  }
  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.disposed = true; this.renderer.off("frame", this.revealSelected);
  }
}
