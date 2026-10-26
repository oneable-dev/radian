import { BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionDialog, ExtensionUiResponse } from "../extension-ui.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { Clipboard } from "../../ui/clipboard.ts";
import { openLoginUrl } from "../../accounts/browser.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { singleLine } from "../../ui/text.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import { SearchPopupLayout, centerPopup } from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { createTextMatcher } from "../../search.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { FooterShortcut } from "../../ui/footer.ts";

type Scope = { sessionId: string; conversationId: string; dialog: ExtensionDialog };
export type ExtensionDialogActions = {
  answer: (sessionId: string, conversationId: string, response: ExtensionUiResponse) => Promise<Result<void, ExpectedError>>;
  changed: () => void; fallback: () => void; notice: Notice;
  keyHint: (command: CommandId, context: KeyContext) => string;
};
const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");

export class ExtensionDialogPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  readonly input: InputRenderable;
  private readonly panel: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly title: TextRenderable;
  private readonly details: ScrollBoxRenderable;
  private readonly body: TextRenderable;
  private readonly status: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly clipboard: Clipboard;
  private scope: Scope | undefined;
  private owner: Renderable | undefined;
  private coveredFocus: Renderable | undefined;
  private candidates: { label: string; value: string | boolean }[] = [];
  private filtered: typeof this.candidates = [];
  private rows: TextRenderable[] = [];
  private cursor = 0;
  private busy = false;
  private completedId: string | undefined;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: ExtensionDialogActions) {
    const theme = uiTheme(renderer); this.clipboard = new Clipboard(renderer);
    this.root = new BoxRenderable(renderer, { id: "extension-dialog", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5700, visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "extension-dialog-panel", position: "absolute", border: true, paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0 });
    const header = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row" });
    this.title = new TextRenderable(renderer, { id: "extension-dialog-title", flexGrow: 1, height: 1, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "extension-dialog-loading" }); header.add(this.title); header.add(this.spinner.root);
    this.details = new ScrollBoxRenderable(renderer, { id: "extension-dialog-details", flexGrow: 1, minHeight: 1, minWidth: 0, scrollX: false, onMouseDown: () => this.details.focus() });
    this.body = new TextRenderable(renderer, { id: "extension-dialog-body", width: "100%", wrapMode: "char", selectable: true }); this.details.add(this.body);
    this.search = new SearchInput(renderer, { id: "extension-dialog-search", placeholder: "Search options…" });
    this.list = new ScrollBoxRenderable(renderer, { id: "extension-dialog-list", flexGrow: 1, minHeight: 1, minWidth: 0, scrollX: false, onMouseDown: () => this.list.focus() });
    this.input = new InputRenderable(renderer, { id: "extension-dialog-input", width: "100%", maxLength: 65536, visible: false });
    this.status = new TextRenderable(renderer, { id: "extension-dialog-status", height: 1, flexShrink: 0, wrapMode: "none", visible: false, selectable: false });
    this.layout = new SearchPopupLayout(renderer, { id: "extension", search: this.search, list: this.list });
    this.panel.add(header); this.panel.add(this.details); this.panel.add(this.layout.root); this.panel.add(this.input); this.panel.add(this.status); this.root.add(this.panel);
    theme.scrollbars(this.details); theme.scrollbars(this.list); theme.input(this.input);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg; this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      paintText(this.title, styles["ui.popupTitle"]); paintText(this.body, styles["ui.label"]); paintText(this.status, styles["ui.muted"]); this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
  }
  get visible(): boolean { return !this.disposed && this.root.visible; }
  get context(): KeyContext { return this.input.focused ? "extension-input" : this.search.focused ? "extension-search" : this.details.focused ? "extension-body" : "extension"; }
  get focusTargets(): Renderable[] { return [this.details, this.search, this.list, this.input].filter(node => node === this.search ? this.search.field.visible : node.visible); }
  get shortcuts(): FooterShortcut[] {
    const commands: [CommandId, string][] = [["extension.submit", "Accept"], ["extension.dismiss", "Cancel"]];
    if (this.url) commands.push(["extension.browser", "Open URL"], ["extension.copy-url", "Copy URL"]);
    return commands.map(([command, label]) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label }));
  }
  update(scope?: Scope): void {
    if (this.disposed) return;
    if (!scope || scope.dialog.id === this.completedId) { this.hide(); return; }
    if (this.scope?.dialog.id === scope.dialog.id && this.scope.conversationId === scope.conversationId && this.scope.sessionId === scope.sessionId) {
      if (!this.visible) {
        this.root.visible = true;
        if (this.coveredFocus && !this.coveredFocus.isDestroyed) this.coveredFocus.focus();
        else (this.input.visible ? this.input : this.list).focus();
        this.coveredFocus = undefined; this.actions.changed();
      }
      return;
    }
    this.hide(); this.scope = scope; this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    const dialog = scope.dialog;
    this.title.content = `Extension · ${dialog.kind === "input" ? "Input" : dialog.kind === "select" ? "Select" : "Confirm"}`;
    this.body.content = plain(dialog.title + (dialog.kind === "confirm" ? `\n\n${dialog.message}` : ""));
    this.input.value = ""; this.input.placeholder = dialog.kind === "input" ? plain(dialog.placeholder ?? "") : "";
    this.input.visible = dialog.kind === "input"; this.search.field.visible = dialog.kind === "select"; this.list.visible = dialog.kind !== "input";
    this.candidates = dialog.kind === "select" ? dialog.options.map(value => ({ label: singleLine(plain(value)), value }))
      : dialog.kind === "confirm" ? [{ label: "No", value: false }, { label: "Yes", value: true }] : [];
    this.cursor = 0; this.search.clear(); this.filter(); this.status.visible = false; this.busy = false;
    this.root.visible = true; this.resize(); this.details.scrollTo(0);
    if (dialog.kind === "input") this.input.focus(); else if (dialog.kind === "select") this.search.focus(); else this.list.focus();
    this.actions.changed();
  }
  suspend(): void {
    if (!this.visible) return;
    this.coveredFocus = this.renderer.currentFocusedRenderable ?? undefined;
    this.root.visible = false; this.spinner.cancel();
  }
  private hide(): void {
    if (!this.visible && !this.scope) return;
    const restore = this.visible;
    this.coveredFocus = undefined;
    this.root.visible = false; this.scope = undefined; this.busy = false; this.spinner.cancel(); this.input.value = ""; this.body.content = ""; this.search.clear();
    this.candidates = []; this.filtered = []; this.paint();
    const owner = this.owner; this.owner = undefined;
    let available = !!owner && !owner.isDestroyed;
    for (let node = owner; node; node = node.parent as Renderable | undefined) available &&= node.visible;
    if (restore) { if (available && owner) owner.focus(); else this.actions.fallback(); }
    this.actions.changed();
  }
  private filter = (): void => {
    const match = createTextMatcher(this.search.value);
    this.filtered = this.candidates.filter(candidate => match(candidate.label)); this.cursor = Math.max(0, Math.min(this.cursor, this.filtered.length - 1)); this.paint();
  };
  private paint(): void {
    if (!this.list || this.list.isDestroyed) return;
    while (this.rows.length > this.filtered.length) this.rows.pop()!.destroyRecursively();
    const styles = uiTheme(this.renderer).styles;
    this.filtered.forEach((candidate, index) => {
      let row = this.rows[index];
      if (!row) {
        row = new TextRenderable(this.renderer, { id: `extension-option:${index}`, height: 1, width: "100%", wrapMode: "none", selectable: false,
          onMouseDown: event => { if (event.button === 0) { event.preventDefault(); this.cursor = index; this.list.focus(); this.paint(); } } });
        this.rows.push(row); this.list.add(row);
      }
      row.content = candidate.label;
      paintText(row, styles[index === this.cursor ? "sidebar.selected" : "sidebar.item"]);
    });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
    this.layout.root.visible = this.list.visible;
    this.layout.results.showEmpty(this.scope?.dialog.kind === "select" && !this.filtered.length
      ? this.search.value ? "No matching options" : "No available options" : undefined);
  }
  available(command: CommandId): boolean {
    if (!this.visible || !command.startsWith("extension.")) return false;
    if (command === "extension.search") return this.scope?.dialog.kind === "select";
    if (command === "extension.browser" || command === "extension.copy-url") return !!this.url;
    return true;
  }
  command(command: CommandId): void {
    if (!this.available(command)) return;
    if (command === "extension.dismiss") { this.launch(() => this.answer(true)); return; }
    if (command === "extension.submit") { this.launch(() => this.answer(false)); return; }
    if (command === "extension.search") { this.search.focus(); return; }
    if (command === "extension.browser" || command === "extension.copy-url") { this.launch(() => this.useUrl(command === "extension.browser")); return; }
    const step = command === "extension.previous" || command === "extension.half-page-up" ? -1 : 1;
    const half = command === "extension.half-page-up" || command === "extension.half-page-down";
    if (!["extension.previous", "extension.next", "extension.half-page-up", "extension.half-page-down"].includes(command)) return;
    if (this.details.focused) { this.details.scrollBy(step * (half ? halfPageStep(this.details.viewport.height) : 1)); return; }
    if (this.input.focused) return;
    if (half && this.search.focused) this.list.focus();
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + step * (half ? halfPageStep(this.list.viewport.height) : 1))); this.paint(); this.actions.changed();
  }
  private async answer(cancelled: boolean): Promise<void> {
    const scope = this.scope; if (!scope || this.busy) return;
    const candidate = this.filtered[this.cursor];
    if (!cancelled && scope.dialog.kind !== "input" && !candidate) return;
    const response: ExtensionUiResponse = cancelled ? { requestId: scope.dialog.id, cancelled: true }
      : scope.dialog.kind === "input" ? { requestId: scope.dialog.id, value: this.input.value }
      : scope.dialog.kind === "confirm" ? { requestId: scope.dialog.id, confirmed: candidate!.value === true }
      : { requestId: scope.dialog.id, value: String(candidate!.value) };
    this.busy = true; this.spinner.start();
    let result: Result<void, ExpectedError>;
    try { result = await this.actions.answer(scope.sessionId, scope.conversationId, response); }
    finally { if (this.scope === scope) { this.busy = false; this.spinner.stop(); } }
    if (this.scope !== scope) return;
    if (!result.ok) { this.status.content = `[${result.error.code}] ${result.error.message}`; this.status.visible = true; return; }
    this.completedId = scope.dialog.id; this.hide();
  }
  private get url(): string | undefined {
    const dialog = this.scope?.dialog;
    return dialog ? plain(dialog.title + (dialog.kind === "confirm" ? `\n${dialog.message}` : "")).match(/https?:\/\/[^\s<>]+/u)?.[0] : undefined;
  }
  private async useUrl(browser: boolean): Promise<void> {
    const url = this.url; if (!url) return;
    const result = browser ? await openLoginUrl(url) : await this.clipboard.copy(url);
    if (!result.ok) this.actions.notice(`[${result.error.code}] ${result.error.message}`, { level: "error" });
    else this.actions.notice(browser ? "Authorization URL opened in the browser." : "Authorization URL copied.", { level: "success" });
  }
  private launch(operation: () => Promise<void>): void { void operation().catch(error => this.actions.notice(reportUnexpected(error, "extension dialog"), { level: "error" })); }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    (this.input.visible ? this.input : this.list).focus();
  };
  private resize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, Math.min(110, this.renderer.width - 4)), height = Math.max(1, Math.min(26, this.renderer.height - 2));
    centerPopup(this.panel, width, height, this.renderer.width, this.renderer.height);
    this.search.fit(Math.max(1, height - 6));
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.disposed = true;
    this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus); this.search.off(InputRenderableEvents.INPUT, this.filter);
    void this.clipboard.dispose().catch(error => reportUnexpected(error, "extension clipboard cleanup"));
  }
}
