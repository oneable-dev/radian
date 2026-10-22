import { BoxRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { ModelCatalog, ModelEffort, ModelIdentity } from "../model-selection.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine } from "../../ui/text.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { uiTheme } from "../../ui/theme.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { Button } from "../../ui/button.ts";
import { halfPageStep } from "../../ui/navigation.ts";

type Scope = { sessionId: string; conversationId: string };
export type ModelPickerActions = {
  list?: (sessionId: string, conversationId: string, signal?: AbortSignal) => Promise<Result<ModelCatalog, ExpectedError>>;
  select?: (sessionId: string, conversationId: string, model: ModelIdentity, effort?: ModelEffort) => Promise<Result<string | null, ExpectedError>>;
  notice: (message: string) => void;
  changed: () => void;
  fallback: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
};
const sameModel = (left: ModelIdentity | null | undefined, right: ModelIdentity | undefined) => !!left && !!right && left.provider === right.provider && left.id === right.id;

// The popup holds plain catalog metadata. Authentication and SDK model objects stay in the runtime.
export class ModelPicker {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  readonly effort: BoxRenderable;
  private readonly effortLabel: TextRenderable;
  private readonly effortOptions: BoxRenderable;
  private readonly effortButtons = new Map<ModelEffort, Button>();
  private readonly effortDrafts = new Map<string, ModelEffort>();
  private effortSignature = "";
  private readonly apply: Button;
  private readonly panel: BoxRenderable;
  private readonly message: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly rows: BoxRenderable[] = [];
  private catalog: ModelCatalog | undefined;
  private filtered: ModelCatalog["models"] = [];
  private scope: Scope | undefined;
  private owner: Renderable | undefined;
  private request: AbortController | undefined;
  private revision = 0;
  private cursor = 0;
  private loading = false;
  private loadError: string | undefined;
  private applying = false;
  private disposed = false;

  constructor(private readonly renderer: CliRenderer, private readonly actions: ModelPickerActions) {
    const theme = uiTheme(renderer);
    this.root = new BoxRenderable(renderer, { id: "model-picker", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5500,
      visible: false,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new BoxRenderable(renderer, { id: "model-dialog", position: "absolute", border: true, paddingX: 1,
      flexDirection: "column", minWidth: 0, minHeight: 0 });
    const heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    const title = new TextRenderable(renderer, { content: "Model & effort · current session", height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "model-loading" });
    const activity = new BoxRenderable(renderer, { height: 1, width: 1, flexShrink: 0 }); activity.add(this.spinner.root);
    const close = new TextRenderable(renderer, { content: "×", height: 1, width: 1, selectable: false,
      onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.hide(); } } });
    heading.add(title); heading.add(activity); heading.add(close);
    this.search = new SearchInput(renderer, { id: "model-search", placeholder: "Search model or provider…" });
    this.message = new TextRenderable(renderer, { id: "model-message", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.list = new ScrollBoxRenderable(renderer, { id: "model-list", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.effort = new BoxRenderable(renderer, { id: "model-effort", width: "100%", flexShrink: 0, flexDirection: "column", focusable: true });
    this.effortLabel = new TextRenderable(renderer, { id: "model-effort-label", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.effortOptions = new BoxRenderable(renderer, { id: "model-effort-options", width: "100%", flexShrink: 0, flexDirection: "row", flexWrap: "wrap" });
    this.effort.add(this.effortLabel); this.effort.add(this.effortOptions);
    const controls = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    this.apply = new Button(renderer, "Apply", () => this.launch(() => this.choose())); this.apply.id = "model-apply";
    const cancel = new Button(renderer, "Cancel", () => this.hide()); cancel.id = "model-cancel";
    controls.add(this.apply); controls.add(cancel);
    this.panel.add(heading); this.panel.add(this.search.field); this.panel.add(this.message); this.panel.add(this.list); this.panel.add(this.effort); this.panel.add(controls); this.root.add(this.panel);
    theme.scrollbars(this.list);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      paintText(title, styles["ui.popupTitle"]); paintText(close, styles["ui.muted"]); paintText(this.message, styles["ui.muted"]); paintText(this.spinner.root, styles["status.working"]);
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    this.effort.on("focused", () => this.paint()); this.effort.on("blurred", () => this.paint());
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
  }

  get visible(): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible; }
  get changing(): boolean { return this.applying; }
  get context(): KeyContext { return this.search.focused ? "model-search" : this.effort.focused || this.effort.hasFocusedDescendant ? "model-effort" : "model"; }
  get focusTargets(): Renderable[] { return [...(this.search.focused ? [this.search] : []), this.list, ...(this.effort.focusable ? [this.effort] : [])]; }
  private get selectedEffort(): ModelEffort | undefined {
    const model = this.filtered[this.cursor]; if (!model) return undefined;
    const draft = this.effortDrafts.get(JSON.stringify([model.provider, model.id]));
    return draft !== undefined && model.efforts.includes(draft) ? draft : model.efforts.includes(model.effort) ? model.effort : undefined;
  }
  get shortcuts(): readonly FooterShortcut[] {
    return ([ ["model.select", "Apply"], ["model.dismiss", "Cancel"], ["model.search", "Search"], ["focus.next", "Model/effort"], ["model.previous", "Previous"], ["model.next", "Next"], ["model.half-page-down", "½ page"], ["model.effort-less", "Less effort"], ["model.effort-more", "More effort"] ] as const)
      .map(([command, label]) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label,
        ...(command === "model.select" ? { disabled: this.loading || this.applying || this.selectedEffort === undefined } : {}) }));
  }

  show(scope: Scope): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.scope = scope; this.catalog = undefined; this.loadError = undefined; this.filtered = []; this.cursor = 0; this.effortDrafts.clear();
    this.root.visible = true; this.search.value = ""; this.filter(); this.resize(); this.list.focus();
    this.launch(() => this.load());
  }
  hide(restoreFocus = true): void {
    if (!this.visible) return;
    this.root.visible = false; this.revision++; this.request?.abort(); this.spinner.cancel(); this.loading = false;
    if (this.applying) this.actions.notice("Model selection is still settling. Closing the popup does not undo an accepted change; check the session model before retrying.");
    const owner = this.owner; this.owner = undefined; this.scope = undefined;
    if (restoreFocus) {
      let visible = !!owner && !owner.isDestroyed;
      for (let node = owner; node; node = node.parent as Renderable | undefined) visible &&= node.visible;
      if (visible && owner) owner.focus(); else this.actions.fallback();
    }
    this.actions.changed();
  }
  updateScope(sessionId: string | null, conversationId: string | undefined, visible: boolean): void {
    if (this.visible && (!visible || sessionId !== this.scope?.sessionId || conversationId !== this.scope?.conversationId)) this.hide();
  }
  private current(revision: number): boolean { return this.visible && revision === this.revision; }
  private launch(operation: () => Promise<void>): void {
    const pending = operation(), revision = this.revision;
    void pending.catch((error: unknown) => {
      const message = reportUnexpected(error, "model picker");
      if (this.current(revision)) { this.message.content = message; this.actions.changed(); }
    });
  }
  private async load(): Promise<void> {
    const scope = this.scope; if (!scope || !this.actions.list || this.applying) return;
    const revision = ++this.revision;
    this.request?.abort(); const request = this.request = new AbortController();
    this.loading = true; this.catalog = undefined; this.loadError = undefined; this.filtered = []; this.filter(); this.spinner.start();
    this.message.content = "Loading available models…"; this.actions.changed();
    let result: Result<ModelCatalog, ExpectedError>;
    try { result = await this.actions.list(scope.sessionId, scope.conversationId, request.signal); }
    finally { if (this.current(revision)) { this.loading = false; this.spinner.stop(); this.actions.changed(); } }
    if (!this.current(revision)) return;
    if (!result.ok) { this.loadError = `[${result.error.code}] ${result.error.message}`; this.message.content = this.loadError; return; }
    if (result.value.conversationId !== scope.conversationId) { this.loadError = "Conversation changed. Close and reopen /model."; this.message.content = this.loadError; return; }
    this.catalog = result.value; this.filter();
  }
  private filter = (): void => {
    if (!this.visible) return;
    const selected = this.filtered[this.cursor] ?? this.catalog?.current;
    const words = this.search.value.normalize("NFKC").toLowerCase().trim().split(/\s+/u);
    const matches = this.catalog?.models.filter(model => {
      const text = `${model.name} ${model.provider}/${model.id}`.normalize("NFKC").toLowerCase();
      return words.every(word => text.includes(word));
    }) ?? [];
    // Keep the current model visible even when a large provider catalog needs display bounds.
    const current = matches.find(model => sameModel(this.catalog?.current, model));
    this.filtered = current ? [current, ...matches.filter(model => model !== current).slice(0, 199)] : matches.slice(0, 200);
    this.cursor = Math.max(0, this.filtered.findIndex(model => sameModel(selected, model)));
    for (const row of this.rows) row.destroyRecursively(); this.rows.length = 0;
    this.filtered.forEach((model, index) => {
      const row = new BoxRenderable(this.renderer, { id: `model:${JSON.stringify([model.provider, model.id])}`, height: 2, flexShrink: 0, minWidth: 0, flexDirection: "column",
        onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.cursor = index; this.list.focus(); this.paint(); } } });
      const label = new TextRenderable(this.renderer, { content: `${singleLine(model.name)}${sameModel(this.catalog?.current, model) ? " [Current]" : ""}`, height: 1, wrapMode: "none", selectable: false });
      const metadata = new TextRenderable(this.renderer, { content: singleLine(`${model.provider}/${model.id} · ${model.contextWindow.toLocaleString("en-US")} context${model.images ? " · images" : ""}`), height: 1, wrapMode: "none", selectable: false });
      uiTheme(this.renderer).bindStyles(row, styles => { paintText(label, styles["ui.label"]); paintText(metadata, styles["ui.muted"]); });
      row.add(label); row.add(metadata); this.rows.push(row); this.list.add(row);
    });
    this.message.content = this.loadError ?? (this.loading ? "Loading available models…" : !this.catalog ? "" : !this.catalog.models.length ? "No available models. Configure provider authentication in Pi first."
      : !matches.length ? "No matching models" : `${matches.length} models${matches.length > 200 ? " · showing first 200; refine search" : ""} · changes apply only to this session`);
    this.list.scrollTo(0); this.paint();
  };
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles;
    this.rows.forEach((row, index) => { row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
    this.paintEffort(); this.actions.changed();
  }
  private paintEffort(): void {
    if (!this.effort || this.effort.isDestroyed) return;
    const model = this.filtered[this.cursor], levels = model?.efforts ?? [], selected = this.selectedEffort;
    const editable = !this.loading && !this.applying && levels.length > 1;
    this.effort.focusable = editable;
    const keys = [this.actions.keyHint("model.effort-less", "model-effort"), this.actions.keyHint("model.effort-more", "model-effort")].filter(Boolean).join("/");
    this.effortLabel.content = !model || selected === undefined ? "Effort unavailable" : !model.reasoning ? "Effort · not supported (off)"
      : levels.length === 1 ? `Effort · ${selected} (fixed)` : `Effort${keys ? ` · ${keys}` : ""}`;
    paintText(this.effortLabel, uiTheme(this.renderer).styles["ui.muted"]);
    const signature = editable || levels.length > 1 ? levels.join(",") : "";
    if (signature !== this.effortSignature) {
      const focused = this.effort.hasFocusedDescendant;
      this.effortSignature = signature;
      for (const button of this.effortButtons.values()) button.destroyRecursively(); this.effortButtons.clear();
      if (signature) for (const level of levels) {
        const button = new Button(this.renderer, level, () => this.setEffort(level)); button.id = `model-effort:${level}`;
        this.effortButtons.set(level, button); this.effortOptions.add(button);
      }
      if (focused && editable) this.effort.focus();
    }
    this.effortOptions.visible = this.effortButtons.size > 0;
    for (const [level, button] of this.effortButtons) { button.active = level === selected; button.setLabel(level === selected ? `[${level}]` : level); }
    const styles = uiTheme(this.renderer).styles;
    this.effort.backgroundColor = styles[this.effort.focused || this.effort.hasFocusedDescendant ? "ui.selectionInactive" : "ui.popup"].bg;
    this.apply.active = !this.loading && !this.applying && selected !== undefined;
    if (!editable && (this.effort.focused || this.effort.hasFocusedDescendant)) this.list.focus();
  }
  private setEffort(level: ModelEffort): void {
    const model = this.filtered[this.cursor];
    if (!model || this.loading || this.applying || !model.efforts.includes(level)) return;
    this.effortDrafts.set(JSON.stringify([model.provider, model.id]), level); this.paint();
  }
  private moveEffort(direction: -1 | 1): void {
    const model = this.filtered[this.cursor], selected = this.selectedEffort;
    if (!model || selected === undefined || this.loading || this.applying) return;
    const index = Math.max(0, Math.min(model.efforts.length - 1, model.efforts.indexOf(selected) + direction));
    const level = model.efforts[index]; if (level !== undefined) this.setEffort(level);
  }
  private async choose(): Promise<void> {
    const scope = this.scope, model = this.filtered[this.cursor], effort = this.selectedEffort;
    if (!scope || !model || effort === undefined || !this.actions.select || this.loading || this.applying) return;
    const revision = this.revision; this.applying = true; this.spinner.start(); this.message.content = "Applying model and effort…"; this.paint();
    let result: Result<string | null, ExpectedError>;
    try { result = await this.actions.select(scope.sessionId, scope.conversationId, { provider: model.provider, id: model.id }, effort); }
    finally { this.applying = false; if (this.current(revision)) { this.spinner.stop(); this.paint(); } }
    if (!this.current(revision)) return;
    if (!result.ok) { this.message.content = `[${result.error.code}] ${result.error.message}`; return; }
    this.hide(); this.actions.notice(result.value ?? `Model set to ${singleLine(model.provider + "/" + model.id)} · effort ${effort} for this session.`);
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "model.dismiss") { this.hide(); return; }
    if (command === "model.select") { this.launch(() => this.choose()); return; }
    if (command === "model.refresh") { this.launch(() => this.load()); return; }
    if (command === "model.search") { this.search.focus(); this.actions.changed(); return; }
    if (command === "model.effort-less" || command === "model.effort-more") { this.moveEffort(command === "model.effort-less" ? -1 : 1); return; }
    const halfPage = command === "model.half-page-up" || command === "model.half-page-down";
    if (halfPage && this.search.focused) this.list.focus();
    if (this.loading || this.applying) return;
    if (command === "model.first") this.cursor = 0;
    else if (command === "model.last") this.cursor = this.filtered.length - 1;
    else if (command === "model.previous" || command === "model.next") this.cursor += command === "model.previous" ? -1 : 1;
    else if (halfPage) this.cursor += (command === "model.half-page-up" ? -1 : 1) * halfPageStep(this.list.viewport.height, 2);
    else return;
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor)); this.paint();
  }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    this.list.focus();
  };
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const width = Math.max(1, Math.min(100, this.renderer.width - 4)), height = Math.max(1, Math.min(24, this.renderer.height - 2));
    this.search.fit(height - 8);
    this.panel.width = width; this.panel.height = height;
    this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.request?.abort(); this.spinner.cancel();
    this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus);
    this.search.off(InputRenderableEvents.INPUT, this.filter); if (!this.root.isDestroyed) this.root.destroyRecursively();
  }
}
