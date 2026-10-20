import { BoxRenderable, InputRenderable, InputRenderableEvents, RGBA, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { ModelCatalog, ModelIdentity } from "../model-selection.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { singleLine } from "../../ui/text.ts";
import { uiTheme } from "../../ui/theme.ts";

type Scope = { sessionId: string; conversationId: string };
export type ModelPickerActions = {
  list?: (sessionId: string, conversationId: string, signal?: AbortSignal) => Promise<Result<ModelCatalog, ExpectedError>>;
  select?: (sessionId: string, conversationId: string, model: ModelIdentity) => Promise<Result<string | null, ExpectedError>>;
  notice: (message: string) => void;
  changed: () => void;
  fallback: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
};
const sameModel = (left: ModelIdentity | null | undefined, right: ModelIdentity | undefined) => !!left && !!right && left.provider === right.provider && left.id === right.id;

// The popup holds plain catalog metadata. Authentication and SDK model objects stay in the runtime.
export class ModelPicker {
  readonly root: BoxRenderable;
  readonly search: InputRenderable;
  readonly list: ScrollBoxRenderable;
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
      visible: false, backgroundColor: RGBA.fromValues(0, 0, 0, 0.45),
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new BoxRenderable(renderer, { id: "model-dialog", position: "absolute", border: true, paddingX: 1,
      flexDirection: "column", minWidth: 0, minHeight: 0 });
    const heading = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1 });
    const title = new TextRenderable(renderer, { content: "Select model · current session", height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "model-loading" });
    const activity = new BoxRenderable(renderer, { height: 1, width: 1, flexShrink: 0 }); activity.add(this.spinner.root);
    const close = new TextRenderable(renderer, { content: "×", height: 1, width: 1, selectable: false,
      onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.hide(); } } });
    heading.add(title); heading.add(activity); heading.add(close);
    this.search = new InputRenderable(renderer, { id: "model-search", width: "100%", placeholder: "Search model or provider…", maxLength: 256, flexShrink: 0 });
    this.message = new TextRenderable(renderer, { id: "model-message", height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.list = new ScrollBoxRenderable(renderer, { id: "model-list", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false,
      contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.panel.add(heading); this.panel.add(this.search); this.panel.add(this.message); this.panel.add(this.list); this.root.add(this.panel);
    theme.input(this.search); theme.scrollbars(this.list);
    theme.bind(this.root, colors => {
      this.panel.backgroundColor = colors.panel; this.panel.borderColor = colors.accent;
      title.fg = colors.accent; close.fg = colors.muted; this.message.fg = colors.muted; this.spinner.root.fg = colors.accent;
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
  }

  get visible(): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible; }
  get changing(): boolean { return this.applying; }
  get context(): KeyContext { return this.search.focused ? "model-search" : "model"; }
  get focusTargets(): Renderable[] { return [this.search, this.list]; }
  get shortcuts(): readonly FooterShortcut[] {
    return ([ ["model.select", "Select"], ["model.previous", "Previous"], ["model.next", "Next"], ["model.refresh", "Refresh"], ["model.dismiss", "Close"] ] as const)
      .map(([command, label]) => ({ key: this.actions.keyHint(command, this.context), label,
        ...(command === "model.select" ? { disabled: this.loading || this.applying || !this.filtered[this.cursor] } : {}) }));
  }

  show(scope: Scope): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.scope = scope; this.catalog = undefined; this.loadError = undefined; this.filtered = []; this.cursor = 0;
    this.root.visible = true; this.search.value = ""; this.filter(); this.resize(); this.search.focus();
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
        onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.cursor = index; this.list.focus(); this.paint(); this.launch(() => this.choose()); } } });
      const label = new TextRenderable(this.renderer, { content: `${singleLine(model.name)}${sameModel(this.catalog?.current, model) ? " [Current]" : ""}`, height: 1, wrapMode: "none", selectable: false });
      const metadata = new TextRenderable(this.renderer, { content: singleLine(`${model.provider}/${model.id} · ${model.contextWindow.toLocaleString("en-US")} context${model.images ? " · images" : ""}`), height: 1, wrapMode: "none", selectable: false });
      uiTheme(this.renderer).bind(row, colors => { label.fg = colors.text; metadata.fg = colors.muted; });
      row.add(label); row.add(metadata); this.rows.push(row); this.list.add(row);
    });
    this.message.content = this.loadError ?? (this.loading ? "Loading available models…" : !this.catalog ? "" : !this.catalog.models.length ? "No available models. Configure provider authentication in Pi first."
      : !matches.length ? "No matching models" : `${matches.length} models${matches.length > 200 ? " · showing first 200; refine search" : ""} · changes apply only to this session`);
    this.list.scrollTo(0); this.paint();
  };
  private paint(): void {
    if (!this.rows) return;
    const colors = uiTheme(this.renderer).colors;
    this.rows.forEach((row, index) => { row.backgroundColor = index === this.cursor ? colors.selected : colors.panel; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id);
    this.actions.changed();
  }
  private async choose(): Promise<void> {
    const scope = this.scope, model = this.filtered[this.cursor];
    if (!scope || !model || !this.actions.select || this.loading || this.applying) return;
    const revision = this.revision; this.applying = true; this.spinner.start(); this.message.content = "Applying model…"; this.actions.changed();
    let result: Result<string | null, ExpectedError>;
    try { result = await this.actions.select(scope.sessionId, scope.conversationId, { provider: model.provider, id: model.id }); }
    finally { this.applying = false; if (this.current(revision)) { this.spinner.stop(); this.actions.changed(); } }
    if (!this.current(revision)) return;
    if (!result.ok) { this.message.content = `[${result.error.code}] ${result.error.message}`; return; }
    this.hide(); this.actions.notice(result.value ?? `Model changed to ${singleLine(model.provider + "/" + model.id)} for this session.`);
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "model.dismiss") { this.hide(); return; }
    if (command === "model.select") { this.launch(() => this.choose()); return; }
    if (command === "model.refresh") { this.launch(() => this.load()); return; }
    if (this.loading || this.applying) return;
    if (command === "model.first") this.cursor = 0;
    else if (command === "model.last") this.cursor = this.filtered.length - 1;
    else if (command === "model.previous" || command === "model.next") this.cursor += command === "model.previous" ? -1 : 1;
    else return;
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor)); this.paint();
  }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    this.search.focus();
  };
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const width = Math.max(1, Math.min(100, this.renderer.width - 4)), height = Math.max(1, Math.min(24, this.renderer.height - 2));
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
