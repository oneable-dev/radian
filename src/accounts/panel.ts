import { BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { type AccountReply, type AccountRequest, type AccountsCatalog, type LoginView } from "./model.ts";
import { SecretInput } from "./secret-input.ts";
import { openLoginUrl } from "./browser.ts";
import { Clipboard } from "../ui/clipboard.ts";
import { SearchInput } from "../ui/search-input.ts";
import { LoadingSpinner } from "../ui/loading-spinner.ts";
import { halfPageStep } from "../ui/navigation.ts";
import { singleLine } from "../ui/text.ts";
import type { Notice } from "../ui/messages.ts";
import { uiTheme } from "../ui/theme.ts";
import { PopupFrame } from "../ui/popup-frame.ts";
import { paintText } from "../ui/theme-styles.ts";
import { footerKeyHint } from "../keybindings/footer.ts";
import type { CommandId, KeyContext } from "../keybindings/commands.ts";
import type { FooterShortcut } from "../ui/footer.ts";
import { reportUnexpected, type ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";
import { createTextMatcher } from "../search.ts";

export type AccountsActions = {
  request?: (request: AccountRequest, signal?: AbortSignal) => Promise<Result<AccountReply, ExpectedError>>;
  openUrl?: (url: string) => Promise<Result<void, ExpectedError>>;
  copy?: (text: string) => Promise<Result<string, ExpectedError>>;
  changed: () => void; notice: Notice; fallback: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
};
type Candidate = { id: string; label: string; detail: string; accountId?: string; choose: () => void };
type Stage = "accounts" | "providers" | "methods" | "label" | "login" | "delete";

export class AccountsPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly message: TextRenderable;
  private readonly details: ScrollBoxRenderable;
  private readonly body: TextRenderable;
  private readonly input: InputRenderable;
  private readonly secret: SecretInput;
  private readonly spinner: LoadingSpinner;
  private readonly clipboard: Clipboard;
  private readonly rows: BoxRenderable[] = [];
  private readonly opened = new Set<string>();
  private stage: Stage = "accounts";
  private candidates: Candidate[] = [];
  private filtered: Candidate[] = [];
  private cursor = 0;
  private catalog: AccountsCatalog | undefined;
  private flow: LoginView | undefined;
  private worktreeId: string | undefined;
  private owner: Renderable | undefined;
  private epoch = 0;
  private busy = false;
  private pendingReload = false;
  private activeRequest: AccountRequest["type"] | undefined;
  private watching: AbortController | undefined;
  private provider: AccountsCatalog["providers"][number] | undefined;
  private method: "api_key" | "oauth" = "oauth";
  private promptId: string | undefined;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(private readonly renderer: CliRenderer, private readonly actions: AccountsActions) {
    // Account list, login body and the focus trap own these native layout subscriptions.
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 4;
    if (this.listenerBudget) renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    const theme = uiTheme(renderer); this.clipboard = new Clipboard(renderer);
    this.root = new BoxRenderable(renderer, { id: "accounts-picker", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", visible: false, zIndex: 5600,
      onMouseDown: event => event.stopPropagation(), onMouseScroll: event => event.stopPropagation() });
    this.panel = new PopupFrame(renderer, { id: "accounts-dialog", position: "absolute", border: true, paddingX: 1, flexDirection: "column", minWidth: 0, minHeight: 0 });
    const header = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row" });
    this.title = new TextRenderable(renderer, { content: "Accounts", height: 1, flexGrow: 1, wrapMode: "none", selectable: false });
    this.spinner = new LoadingSpinner(renderer, { id: "accounts-loading" }); header.add(this.title); header.add(this.spinner.root);
    this.search = new SearchInput(renderer, { id: "accounts-search", placeholder: "Search accounts or providers…" });
    this.message = new TextRenderable(renderer, { id: "accounts-message", height: 2, flexShrink: 0, wrapMode: "word", selectable: false });
    this.list = new ScrollBoxRenderable(renderer, { id: "accounts-list", flexGrow: 1, minHeight: 0, minWidth: 0, scrollX: false, contentOptions: { flexDirection: "column" }, onMouseDown: () => this.list.focus() });
    this.details = new ScrollBoxRenderable(renderer, { id: "accounts-login-details", flexGrow: 1, minHeight: 0, scrollX: false, visible: false, onMouseDown: () => this.details.focus() });
    this.body = new TextRenderable(renderer, { id: "accounts-login-body", width: "100%", wrapMode: "char", selectable: true }); this.details.add(this.body);
    this.input = new InputRenderable(renderer, { id: "accounts-input", width: "100%", visible: false, maxLength: 65536 });
    this.secret = new SecretInput(renderer); this.secret.visible = false;
    this.panel.add(header); this.panel.add(this.search.field); this.panel.add(this.message); this.panel.add(this.list); this.panel.add(this.details); this.panel.add(this.input); this.panel.add(this.secret); this.root.add(this.panel);
    theme.scrollbars(this.list); theme.scrollbars(this.details); theme.input(this.input);
    theme.bindStyles(this.root, styles => {
      this.root.backgroundColor = styles["ui.backdrop"].bg; this.panel.backgroundColor = styles["ui.popup"].bg; this.panel.borderColor = styles["ui.popupBorder"].fg;
      paintText(this.title, styles["ui.popupTitle"]); paintText(this.message, styles["ui.muted"]); paintText(this.body, styles["ui.label"]); paintText(this.spinner.root, styles["status.working"]); this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize); renderer.on("focused_renderable", this.keepFocus); this.resize();
  }
  get visible(): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible; }
  get context(): KeyContext { return this.secret.focused || this.input.focused ? "accounts-input" : this.search.focused ? "accounts-search" : "accounts"; }
  get focusTargets(): Renderable[] { return [this.search, this.list, this.details, this.input, this.secret].filter(node => node.visible && (node !== this.search || this.search.field.visible)); }
  get shortcuts(): readonly FooterShortcut[] {
    return ([ ["accounts.choose", "Continue"], ["accounts.dismiss", "Back / Cancel"], ["accounts.search", "Search"], ["accounts.previous", "Previous"], ["accounts.next", "Next"], ["accounts.half-page-down", "½ page"], ["accounts.delete", "Delete account"], ["accounts.browser", "Open browser"], ["accounts.copy-url", "Copy URL"], ["accounts.copy-code", "Copy code"] ] as const)
      .filter(([command]) => command !== "accounts.choose" || !this.busy && (this.stage === "label" || this.stage === "login" && !!this.flow?.prompt || this.list.visible && this.filtered.length > 0))
      .filter(([command]) => command !== "accounts.search" || this.search.field.visible)
      .filter(([command]) => command !== "accounts.delete" || this.stage === "accounts" && !!this.filtered[this.cursor]?.accountId)
      .filter(([command]) => command !== "accounts.copy-code" || !!this.code)
      .filter(([command]) => !["accounts.browser", "accounts.copy-url"].includes(command) || !!this.url)
      .map(([command, label]) => ({ key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)), label }));
  }
  show(worktreeId: string): void {
    if (this.visible || this.disposed) return;
    this.owner = this.renderer.currentFocusedRenderable ?? undefined; this.worktreeId = worktreeId; this.epoch++; this.root.visible = true; this.stage = "accounts"; this.list.focus(); this.resize(); this.launch(() => this.load());
  }
  hide(restore = true): void {
    if (!this.visible) return;
    const worktreeId = this.worktreeId, flow = this.flow;
    if (restore && this.busy && this.activeRequest && ["select", "delete", "login", "answer"].includes(this.activeRequest)) this.actions.notice("Account action is still settling. Closing does not undo an accepted save or selection; reopen /accounts to confirm before retrying.", { level: "warning" });
    this.activeRequest = undefined;
    this.epoch++; this.root.visible = false; this.watching?.abort(); this.spinner.cancel(); this.busy = false; this.pendingReload = false; this.flow = undefined; this.promptId = undefined;
    this.secret.clear(); this.input.value = ""; this.body.content = ""; this.opened.clear();
    if (worktreeId && flow?.status === "pending") this.launch(async () => { await this.actions.request?.({ type: "cancel", worktreeId, flowId: flow.id }); });
    const owner = this.owner; this.owner = undefined;
    let available = !!owner && !owner.isDestroyed; for (let node = owner; node; node = node.parent as Renderable | undefined) available &&= node.visible;
    if (restore) { if (available && owner) owner.focus(); else this.actions.fallback(); }
    this.actions.changed();
  }
  updateScope(worktreeId: string | null): void { if (this.visible && worktreeId !== this.worktreeId) this.hide(); }
  private launch(operation: () => Promise<void>): void {
    void operation().catch(error => { const message = reportUnexpected(error, "accounts popup"); if (this.visible) this.message.content = message; });
  }
  private async perform(request: AccountRequest): Promise<void> {
    if (!this.actions.request || this.busy) return;
    const epoch = this.epoch; this.busy = true; this.activeRequest = request.type; this.spinner.start();
    let result: Result<AccountReply, ExpectedError>;
    try { result = await this.actions.request(request); }
    finally {
      if (this.visible && epoch === this.epoch) {
        this.busy = false; this.activeRequest = undefined; this.spinner.stop();
        if (this.pendingReload) { this.pendingReload = false; queueMicrotask(() => { if (this.visible && epoch === this.epoch) this.launch(() => this.load()); }); }
      }
    }
    if (!this.visible || epoch !== this.epoch) {
      if (result.ok && result.value.kind === "login" && result.value.login.status === "pending") await this.actions.request({ type: "cancel", worktreeId: request.worktreeId, flowId: result.value.login.id });
      return;
    }
    if (request.type === "answer" && this.flow?.id !== request.flowId) return;
    if (!result.ok) { this.message.content = `[${result.error.code}] ${result.error.message}`; return; }
    if (result.value.kind === "catalog") {
      this.catalog = result.value.catalog; this.main();
      const warning = [result.value.warning, this.catalog.warning].filter(Boolean).join(" · "); if (warning) this.message.content = warning;
    } else {
      this.accept(result.value.login);
      if (request.type === "login") this.launch(() => this.watch());
    }
    this.actions.changed();
  }
  private async load(): Promise<void> { if (this.worktreeId) await this.perform({ type: "list", worktreeId: this.worktreeId }); }
  private menu(stage: Stage, title: string, message: string, candidates: Candidate[]): void {
    this.stage = stage; this.title.content = title; this.message.content = message; this.candidates = candidates; this.cursor = 0;
    this.secret.clear(); this.secret.visible = this.input.visible = false; this.input.value = "";
    this.details.visible = false; this.body.content = "";
    this.search.field.visible = true; this.list.visible = true; this.search.clear(); this.filter(); this.list.focus();
  }
  private main(): void {
    const catalog = this.catalog, worktreeId = this.worktreeId; if (!catalog || !worktreeId) return;
    this.flow = undefined; this.promptId = undefined;
    const entries: Candidate[] = [{ id: "add", label: "+ Add account", detail: "Sign in to another account", choose: () => this.providers() }];
    const names = new Map(catalog.providers.map(provider => [provider.id, provider.name]));
    const existing = new Map((catalog.existingAccounts ?? []).map(account => [account.provider, account]));
    for (const account of existing.values()) names.set(account.provider, account.name);
    const providers = new Set([...existing.keys(), ...catalog.accounts.map(account => account.provider)]);
    for (const provider of [...providers].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b))) {
      const name = names.get(provider) ?? provider;
      const choose = (accountId: string | null) => this.launch(() => this.perform({ type: "select", worktreeId, provider, accountId, revision: catalog.revision }));
      const connection = existing.get(provider);
      if (connection) entries.push({ id: `existing:${provider}`, label: `${name} · ${connection.type === "oauth" ? "Existing login" : "Existing API key"}${catalog.selections[provider] ? "" : " [Active]"}`,
        detail: `${connection.type === "oauth" ? "OAuth" : "API key"} · already connected`, choose: () => choose(null) });
      for (const account of catalog.accounts.filter(account => account.provider === provider)) entries.push({ id: account.id, accountId: account.id,
        label: `${name} · ${account.label}${catalog.selections[provider] === account.id ? " [Active]" : ""}`, detail: `${account.type === "oauth" ? "OAuth" : "API key"} · used by ${account.usedBy.length} worktree(s)`, choose: () => choose(account.id) });
    }
    this.menu("accounts", "Accounts", providers.size ? "Enter switches accounts for this worktree. Use Add account to sign in to another account."
      : "No connected accounts. Choose Add account to sign in.", entries);
  }
  private providers(): void {
    this.menu("providers", "Add account · provider", "Choose a service to sign in.", (this.catalog?.providers ?? []).map(provider => ({
      id: provider.id, label: provider.name, detail: "", choose: () => this.methods(provider),
    })));
  }
  private methods(provider: AccountsCatalog["providers"][number]): void {
    this.provider = provider;
    this.menu("methods", `Add account · ${singleLine(provider.name)}`, "Choose how to sign in. OAuth does not require a separate API key.", provider.methods.map(method => ({ id: method.id, label: method.name, detail: "", choose: () => {
      this.method = method.id; this.menu("label", "Add account · name", "Enter a label for the shared account, or press Enter to use the provider name.", []);
      this.search.field.visible = this.list.visible = false; this.input.visible = true; this.input.placeholder = "Account label"; this.input.maxLength = 128; this.input.focus();
    } })));
  }
  private accept(login: LoginView): void {
    if (this.flow?.id === login.id && this.flow.revision > login.revision) return;
    const first = this.stage !== "login" || this.flow?.id !== login.id;
    this.flow = login;
    if (login.status === "complete") {
      this.actions.notice(`Account added: ${singleLine(login.account?.label ?? "new account")}. Select it explicitly to use it in this worktree.`, { level: "success" });
      this.main(); if (this.busy) this.pendingReload = true; else this.launch(() => this.load()); return;
    }
    if (login.status === "cancelled" || login.status === "error") {
      this.spinner.stop(); this.main(); this.message.content = login.error ?? "Login cancelled. Existing accounts and selections were retained."; return;
    }
    this.stage = "login"; this.title.content = `Add account · ${singleLine(this.provider?.name ?? "provider")}`;
    this.details.visible = true; this.body.content = login.events.map(event => [event.message, event.url, event.code ? `Code: ${event.code}` : undefined].filter(Boolean).join("\n")).join("\n\n");
    const prompt = login.prompt;
    this.message.content = prompt?.message ?? "Waiting for browser authentication… You can always copy or reopen the URL.";
    if (first || prompt?.id !== this.promptId) {
      this.promptId = prompt?.id; this.secret.clear(); this.input.value = ""; this.cursor = 0;
      this.candidates = (prompt?.options ?? []).map(option => ({ id: option.id, label: option.label, detail: option.description ?? "", choose: () => this.answer(option.id) }));
      this.search.field.visible = this.list.visible = prompt?.type === "select";
      this.secret.visible = prompt?.type === "secret" || prompt?.type === "manual_code";
      this.input.visible = prompt?.type === "text"; this.input.maxLength = 65536; this.input.placeholder = prompt?.placeholder ?? "Enter the requested value";
      this.search.clear(); this.filter();
      if (this.secret.visible) this.secret.focus(); else if (this.input.visible) this.input.focus(); else if (this.list.visible) this.list.focus(); else this.details.focus();
    }
    if (this.url && !this.opened.has(this.url)) { this.opened.add(this.url); this.launch(() => this.openBrowser()); }
    this.actions.changed();
  }
  private async watch(): Promise<void> {
    this.watching?.abort(); const controller = this.watching = new AbortController(), epoch = this.epoch;
    while (this.visible && epoch === this.epoch && this.flow?.status === "pending" && this.worktreeId && !controller.signal.aborted) {
      const flowId = this.flow.id;
      const result = await this.actions.request!({ type: "poll", worktreeId: this.worktreeId, flowId, revision: this.flow.revision }, controller.signal);
      if (!this.visible || epoch !== this.epoch || controller.signal.aborted || this.flow?.id !== flowId || this.flow.status !== "pending") return;
      if (!result.ok) { this.message.content = `[${result.error.code}] Login status is unknown. Close to cancel, or reopen accounts to check saved accounts.`; return; }
      if (result.value.kind !== "login") { this.message.content = "Unexpected login status reply."; return; }
      this.accept(result.value.login);
    }
  }
  private answer(value: string): void {
    if (!this.flow?.prompt || !this.worktreeId) return;
    const promptId = this.flow.prompt.id; this.secret.clear(); this.input.value = "";
    this.launch(() => this.perform({ type: "answer", worktreeId: this.worktreeId!, flowId: this.flow!.id, promptId, value }));
  }
  private choose(): void {
    if (this.busy) return;
    if (this.stage === "label" && this.provider && this.worktreeId) {
      const label = this.input.value.trim() || this.provider.name; this.input.value = "";
      this.launch(() => this.perform({ type: "login", worktreeId: this.worktreeId!, provider: this.provider!.id, method: this.method, label })); return;
    }
    if (this.stage === "login" && (this.secret.visible || this.input.visible)) { this.answer(this.secret.visible ? this.secret.value : this.input.value); return; }
    this.filtered[this.cursor]?.choose();
  }
  private back(): void {
    if (this.stage === "accounts" || this.stage === "login" || this.busy) { this.hide(); return; }
    if (this.stage === "methods") { this.providers(); return; }
    if (this.stage === "label" && this.provider) { this.methods(this.provider); return; }
    this.main();
  }
  private remove(): void {
    const accountId = this.filtered[this.cursor]?.accountId, catalog = this.catalog, worktreeId = this.worktreeId;
    if (this.stage !== "accounts" || !accountId || !catalog || !worktreeId || this.busy) return;
    const account = catalog.accounts.find(account => account.id === accountId); if (!account) return;
    this.menu("delete", "Delete local account?", `Remove ${singleLine(account.label)} and its saved credential from Radian. This does not delete the service account or conversations.`, [
      { id: "cancel", label: "Keep account", detail: "", choose: () => this.main() },
      { id: "delete", label: "Delete local account", detail: "Switch any worktrees using this account to another connected account first.", choose: () => this.launch(() => this.perform({ type: "delete", worktreeId, accountId, revision: catalog.revision })) },
    ]);
    if (account.usedBy.length) { this.details.visible = true; this.body.content = `Used by these worktrees:\n${account.usedBy.map(id => singleLine(id)).join("\n")}\n\nSwitch them to another connected account before deleting.`; }
  }
  private get url(): string | undefined { return this.flow?.events.findLast(event => event.url)?.url; }
  private get code(): string | undefined { return this.flow?.events.findLast(event => event.code)?.code; }
  private async openBrowser(): Promise<void> {
    const url = this.url, epoch = this.epoch; if (!url) return;
    const result = await (this.actions.openUrl ?? openLoginUrl)(url);
    if (this.visible && epoch === this.epoch && !result.ok) this.message.content = result.error.message;
  }
  private async copy(code: boolean): Promise<void> {
    const text = code ? this.code : this.url, epoch = this.epoch; if (!text) return;
    const result = await (this.actions.copy?.(text) ?? this.clipboard.copy(text));
    if (this.visible && epoch === this.epoch) this.message.content = result.ok ? (code ? "Device code copied." : "Login URL copied.") : result.error.message;
  }
  private get rowHeight(): number { return this.stage === "providers" || this.stage === "methods" ? 1 : 2; }
  private filter = (): void => {
    const matches = createTextMatcher(this.search.value), selected = this.filtered[this.cursor]?.id;
    this.filtered = this.candidates.filter(candidate => matches(`${candidate.label} ${candidate.detail}`)); this.cursor = Math.max(0, this.filtered.findIndex(candidate => candidate.id === selected));
    for (const row of this.rows) row.destroyRecursively(); this.rows.length = 0;
    this.filtered.forEach((candidate, index) => {
      const row = new BoxRenderable(this.renderer, { id: `accounts-row:${candidate.id}`, height: this.rowHeight, flexShrink: 0, flexDirection: "column", minWidth: 0,
        onMouseDown: event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); this.cursor = index; this.list.focus(); this.paint(); } } });
      const label = new TextRenderable(this.renderer, { content: singleLine(candidate.label), height: 1, wrapMode: "none", selectable: false });
      const detail = this.rowHeight === 2 ? new TextRenderable(this.renderer, { content: singleLine(candidate.detail), height: 1, wrapMode: "none", selectable: false }) : undefined;
      uiTheme(this.renderer).bindStyles(row, styles => { paintText(label, styles["ui.label"]); if (detail) paintText(detail, styles["ui.muted"]); });
      row.add(label); if (detail) row.add(detail); this.rows.push(row); this.list.add(row);
    }); this.list.scrollTo(0); this.paint();
  };
  private paint(): void {
    if (!this.rows) return;
    const styles = uiTheme(this.renderer).styles; this.rows.forEach((row, index) => { row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg; });
    const row = this.rows[this.cursor]; if (row) this.list.scrollChildIntoView(row.id); this.actions.changed();
  }
  command(command: CommandId): void {
    if (!this.visible) return;
    if (command === "accounts.dismiss") { this.back(); return; }
    if (command === "accounts.choose") { this.choose(); return; }
    if (command === "accounts.delete") { this.remove(); return; }
    if (command === "accounts.refresh") { if (this.stage === "accounts") this.launch(() => this.load()); return; }
    if (command === "accounts.browser") { this.launch(() => this.openBrowser()); return; }
    if (command === "accounts.copy-url" || command === "accounts.copy-code") { this.launch(() => this.copy(command === "accounts.copy-code")); return; }
    if (command === "accounts.search") { if (this.search.field.visible) this.search.focus(); return; }
    const half = command === "accounts.half-page-up" || command === "accounts.half-page-down";
    const direction = command === "accounts.previous" || command === "accounts.half-page-up" ? -1 : 1;
    if (half && this.search.focused) this.list.focus();
    if (this.details.focused) { this.details.scrollBy(direction * (half ? halfPageStep(this.details.viewport.height) : 1)); return; }
    if (!this.list.visible || this.busy) return;
    if (command === "accounts.previous" || command === "accounts.next" || half) {
      this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + direction * (half ? halfPageStep(this.list.viewport.height, this.rowHeight) : 1))); this.paint();
    }
  }
  private keepFocus = (): void => {
    if (!this.visible) return;
    for (let node = this.renderer.currentFocusedRenderable; node; node = node.parent as Renderable | null) if (node === this.root) return;
    (this.secret.visible ? this.secret : this.input.visible ? this.input : this.list.visible ? this.list : this.details).focus();
  };
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) return;
    const width = Math.max(1, Math.min(106, this.renderer.width - 4)), height = Math.max(1, Math.min(30, this.renderer.height - 2));
    this.search.fit(height - 6); this.panel.width = width; this.panel.height = height;
    this.panel.left = Math.floor((this.renderer.width - width) / 2); this.panel.top = Math.floor((this.renderer.height - height) / 2);
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(false); this.disposed = true; this.watching?.abort(); this.spinner.cancel(); this.secret.clear();
    this.search.off(InputRenderableEvents.INPUT, this.filter); this.renderer.off("resize", this.resize); this.renderer.off("focused_renderable", this.keepFocus);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
    void this.clipboard.dispose().catch(error => reportUnexpected(error, "account clipboard cleanup"));
    if (this.listenerBudget) this.renderer.setMaxListeners(Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget));
  }
}
