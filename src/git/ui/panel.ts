import {
  BoxRenderable, CodeRenderable, DiffRenderable, InputRenderable, ScrollBoxRenderable, SyntaxStyle, TextRenderable,
  Renderable, type CliRenderer, type Selection, type TreeSitterClient,
} from "@opentui/core";
import { CancelledError, InputError, reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import { layoutGraph, type GraphCommit } from "./graph.ts";
import { commitContext, describeCommit, detailsContext, fileContext, gitPrompt, refContext, reflogContext, type GitContext } from "../context.ts";
import { fileKey, initialGitState, type GitComparison, type GitDetails, type GitFile, type GitSnapshot, type GitSource, type GitViewState } from "../model.ts";
import { fullFilePatch } from "../patch.ts";
import type { Worktree } from "../../workspace/model.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { GitList, type GitListItem } from "./list.ts";
import { uiTheme } from "../../ui/theme.ts";
import type { ThemeRole } from "../../ui/theme-config.ts";
import { GitClipboard } from "./clipboard.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";

export type GitActions = {
  source(worktree: Worktree): GitSource;
  createSession(worktreeId: string): Promise<Result<string, ExpectedError>>;
  prompt(sessionId: string, text: string): Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
  treeSitterClient?: TreeSitterClient;
};
type Cache = { state: GitViewState; source: GitSource; data?: GitSnapshot; details?: GitDetails | undefined; comparison?: GitComparison | undefined; error?: string | undefined; diffError?: string | undefined };
type Ask = { context: GitContext; worktree: Worktree; session: string | null; createdSession?: string; owner: Renderable | null; sending: boolean };
type Button = (label: string, activate: () => void, actionLabel?: string) => BoxRenderable;
const workingKey = "__working_tree__";
const display = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
const within = (target: Renderable | null, parent: Renderable): boolean => {
  for (let current: Renderable | null = target; current; current = current.parent instanceof Renderable ? current.parent : null) if (current === parent) return true;
  return false;
};

export class GitPanel {
  readonly root: BoxRenderable;
  private readonly toolbar: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly status: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly main: BoxRenderable;
  private readonly right: BoxRenderable;
  private readonly commitPanel: BoxRenderable;
  private readonly refsPanel: BoxRenderable;
  private readonly history: GitList;
  private readonly files: GitList;
  private readonly refs: GitList;
  private readonly details: ScrollBoxRenderable;
  private readonly detailText: TextRenderable;
  private readonly filesTitle: TextRenderable;
  private readonly diffFocus: BoxRenderable;
  private readonly diffTitle: TextRenderable;
  private readonly diffBody: BoxRenderable;
  private readonly diffNotice: TextRenderable;
  private readonly dialog: BoxRenderable;
  private readonly dialogContext: TextRenderable;
  private readonly targetText: TextRenderable;
  private readonly targetButton: BoxRenderable;
  private readonly prompt: InputRenderable;
  private readonly topButtons: BoxRenderable[] = [];
  private readonly rightButtons: BoxRenderable[] = [];
  private readonly refButtons: BoxRenderable[] = [];
  private readonly dialogButtons: Renderable[] = [];
  private readonly clipboard: GitClipboard;
  private readonly caches = new Map<string, Cache>();
  private readonly requests = new Set<AbortController>();
  private worktree: Worktree | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  private loadRequest?: AbortController;
  private detailRequest?: AbortController;
  private diffRequest?: AbortController;
  private diff: DiffRenderable | undefined;
  private syntax: SyntaxStyle | undefined;
  private renderedComparison: GitComparison | undefined;
  private ask: Ask | undefined;
  private disposed = false;
  private restoring = false;
  private pendingRestore = false;
  private pointer: { x: number; y: number; moved: boolean } | undefined;

  constructor(private readonly renderer: CliRenderer, private readonly actions: GitActions | undefined, button: Button,
    private readonly notice: (message: string) => void, private readonly changed: () => void,
    private readonly saved: (id: string, state: GitViewState) => void, private readonly initial: Readonly<Record<string, GitViewState>>,
    private readonly hint: (command: CommandId, context: KeyContext) => string) {
    const gitColors = uiTheme(renderer).colors;
    this.clipboard = new GitClipboard(renderer);
    this.root = new BoxRenderable(renderer, { id: "git-view", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", visible: false,
      // Restore against measured list/diff geometry before any viewport is presented.
      renderBefore: this.restoreScroll,
      onMouseDown: (event) => { if (event.button === 0) this.pointer = { x: event.x, y: event.y, moved: false }; },
      onMouseDrag: (event) => { if (this.pointer && (this.pointer.x !== event.x || this.pointer.y !== event.y)) this.pointer.moved = true; } });
    this.toolbar = this.row();
    for (const [index, label] of ["Commits", "Reflog"].entries()) {
      const control = button(label, () => this.setTab(index === 0 ? "commits" : "reflog"));
      this.topButtons.push(control); this.toolbar.add(control);
    }
    const refresh = button("Refresh", () => this.refresh(), "Refresh Git");
    const more = button("+ More", () => this.more(), "Load more commits");
    this.toolbar.add(refresh); this.toolbar.add(more); this.topButtons.push(refresh, more);
    this.spinner = new LoadingSpinner(renderer, { id: "git-loading", fg: gitColors.accent }); this.toolbar.add(this.spinner.root);
    this.root.add(this.toolbar);
    this.title = this.text("Git", "muted"); this.root.add(this.title);
    this.status = new TextRenderable(renderer, { id: "git-status", content: "", fg: gitColors.muted, height: 1, flexShrink: 0, selectable: false, wrapMode: "none" });
    this.root.add(this.status);
    this.body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "row" });
    this.main = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column",
      onSizeChange: () => { if (this.cache && this.root.visible) { this.remember(); this.pendingRestore = true; this.render(); } } });
    this.history = new GitList(renderer, "git-history", (key) => this.chooseHistory(key), () => {});
    this.main.add(this.history.root);
    this.diffFocus = new BoxRenderable(renderer, { id: "git-diff", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", focusable: true, visible: false,
      onMouseDown: () => this.diffFocus.focus(), onMouseScroll: () => this.remember() });
    const diffToolbar = this.row();
    const back = button("← Commits", () => this.back(), "Back to commits"); this.topButtons.push(back); diffToolbar.add(back);
    this.diffTitle = this.text("Before / After", "accent"); this.diffTitle.flexGrow = 1; this.diffTitle.minWidth = 0; diffToolbar.add(this.diffTitle);
    this.diffFocus.add(diffToolbar);
    this.diffBody = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" });
    this.diffNotice = new TextRenderable(renderer, { content: "", fg: gitColors.muted, wrapMode: "word", selectable: false });
    this.diffBody.add(this.diffNotice); this.diffFocus.add(this.diffBody); this.main.add(this.diffFocus);
    this.right = new BoxRenderable(renderer, { id: "git-right", width: "38%", minWidth: 16, flexShrink: 0, minHeight: 0, flexDirection: "column", border: ["left"], borderColor: gitColors.muted });
    const rightTabs = this.row();
    for (const name of ["Commit", "Refs"] as const) {
      const control = button(name, () => { const state = this.cache?.state; if (state) { this.remember(); state.right = name === "Commit" ? "commit" : "refs"; this.persist(); this.render(); } });
      this.rightButtons.push(control); rightTabs.add(control);
    }
    this.right.add(rightTabs);
    this.commitPanel = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column" });
    this.details = new ScrollBoxRenderable(renderer, { id: "git-details", height: "40%", minHeight: 3, scrollX: false, onMouseDown: () => this.details.focus() });
    this.detailText = new TextRenderable(renderer, { id: "git-detail-text", content: "", fg: gitColors.text, width: "100%", wrapMode: "word", selectable: true });
    this.details.add(this.detailText); this.commitPanel.add(this.details);
    this.filesTitle = this.text("Changed files", "accent"); this.commitPanel.add(this.filesTitle);
    this.files = new GitList(renderer, "git-files", (key) => {
      if (this.cache) { this.cache.state.file = key; this.persist(); this.changed(); if (this.cache.state.diff) this.openDiff(false); }
    }, () => { if (!this.cache?.state.diff) this.openDiff(false); });
    this.commitPanel.add(this.files.root); this.right.add(this.commitPanel);
    this.refsPanel = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column" });
    const refTabs = this.row();
    for (const [index, label] of ["Local", "Remote", "Tags"].entries()) {
      const control = button(label, () => { if (this.cache) { this.remember(); this.cache.state.refs = (["local", "remote", "tag"] as const)[index]!; this.persist(); this.render(); } });
      this.refButtons.push(control); refTabs.add(control);
    }
    const all = button("All refs", () => this.filter(null), "Show all refs"); this.refButtons.push(all);
    this.refsPanel.add(refTabs); this.refsPanel.add(all);
    this.refs = new GitList(renderer, "git-refs", (key) => { if (this.cache) { this.cache.state.refSelected = key; this.persist(); this.changed(); } }, (key) => this.filter(key));
    this.refsPanel.add(this.refs.root); this.right.add(this.refsPanel);
    this.body.add(this.main); this.body.add(this.right); this.root.add(this.body);
    this.dialog = new BoxRenderable(renderer, { id: "git-ask", position: "absolute", left: 0, right: 0, bottom: 0, height: 10,
      zIndex: 100, border: true, borderColor: gitColors.accent, backgroundColor: gitColors.panel, paddingX: 1, flexDirection: "column", visible: false });
    this.dialog.add(this.text("Ask Agent · selected Git context", "accent"));
    this.dialogContext = new TextRenderable(renderer, { content: "", height: 2, wrapMode: "word", fg: gitColors.text, selectable: false }); this.dialog.add(this.dialogContext);
    const targetRow = this.row();
    this.targetText = this.text("Session: "); targetRow.add(this.targetText);
    this.targetButton = button("Change session", () => this.cycleSession(), "Choose session"); targetRow.add(this.targetButton); this.dialog.add(targetRow);
    this.prompt = new InputRenderable(renderer, { id: "git-prompt", width: "100%", placeholder: "Prompt · Enter to send", textColor: gitColors.text,
      backgroundColor: gitColors.panel, focusedBackgroundColor: gitColors.selected }); this.dialog.add(this.prompt);
    const dialogControls = this.row();
    const send = button("Send", () => this.launch(() => this.submit()), "Send Git context");
    const cancel = button("Cancel", () => this.closeAsk(), "Cancel request");
    this.dialogButtons.push(this.targetButton, this.prompt, send, cancel); dialogControls.add(send); dialogControls.add(cancel);
    this.dialog.add(dialogControls); this.root.add(this.dialog);
    renderer.on("selection", this.selectionFinished);
    for (const box of [this.history.root, this.files.root, this.refs.root, this.details]) {
      box.verticalScrollBar.on("change", this.remember);
      box.content.on("resize", this.applyScroll); box.viewport.on("resize", this.applyScroll);
    }
    const theme = uiTheme(renderer);
    theme.input(this.prompt); theme.scrollbars(this.details);
    theme.bind(this.root, (colors) => {
      this.spinner.root.fg = colors.accent; this.status.fg = colors.muted; this.diffNotice.fg = colors.muted;
      this.right.borderColor = colors.muted; this.dialog.borderColor = colors.accent; this.dialog.backgroundColor = colors.panel;
      this.detailText.fg = colors.text; this.detailText.selectionBg = colors.selected; this.detailText.selectionFg = colors.text;
      this.dialogContext.fg = colors.text; this.paintTabs();
      // Rebuild once with all diff colors, rather than invoking a full native rebuild for every color setter.
      if (this.diff) {
        this.remember(); this.diff.destroyRecursively(); this.diff = undefined;
        this.renderedComparison = undefined; this.pendingRestore = true;
      }
      this.syntax?.destroy(); this.syntax = undefined;
      this.renderDiff();
    });
  }

  private row(): BoxRenderable { return new BoxRenderable(this.renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 1, minWidth: 0 }); }
  private text(content: string, role: ThemeRole = "text"): TextRenderable {
    const text = new TextRenderable(this.renderer, { content, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    uiTheme(this.renderer).bind(text, (colors) => { text.fg = colors[role]; });
    return text;
  }
  private paintTabs(): void {
    const state = this.cache?.state, colors = uiTheme(this.renderer).colors;
    if (!state) return;
    this.topButtons[0]!.backgroundColor = state.tab === "commits" ? colors.selected : colors.panel;
    this.topButtons[1]!.backgroundColor = state.tab === "reflog" ? colors.selected : colors.panel;
    this.rightButtons[0]!.backgroundColor = state.right === "commit" ? colors.selected : colors.panel;
    this.rightButtons[1]!.backgroundColor = state.right === "refs" ? colors.selected : colors.panel;
    for (const [index, kind] of ["local", "remote", "tag"].entries()) this.refButtons[index]!.backgroundColor = state.refs === kind ? colors.selected : colors.panel;
  }
  get modal(): boolean { return this.dialog.visible; }
  focus(): void { if (this.root.visible && this.cache) this.history.root.focus(); }
  private get cache(): Cache | undefined { return this.worktree ? this.caches.get(this.worktree.id) : undefined; }
  private get selectedFiles(): GitFile[] { return this.cache?.state.selected ? this.cache.details?.files ?? [] : this.cache?.data?.files ?? []; }
  private get selectedFile(): GitFile | undefined { return this.selectedFiles.find((file) => fileKey(file) === this.cache?.state.file); }
  get focusTargets(): Renderable[] {
    if (this.dialog.visible) return this.dialogButtons;
    return [...this.topButtons.filter((control) => this.visible(control)), this.cache?.state.diff && this.cache.state.tab === "commits" ? this.diffFocus : this.history.root,
      ...(this.right.visible ? [...this.rightButtons, ...(this.commitPanel.visible ? [...(this.details.visible ? [this.details] : []), this.files.root]
        : [...this.refButtons, this.refs.root])] : [])];
  }
  private visible(target: Renderable): boolean { for (let node: Renderable | null = target; node; node = node.parent as Renderable | null) if (!node.visible) return false; return true; }
  keyContext(): KeyContext | null {
    const focused = this.renderer.currentFocusedRenderable;
    if (!this.root.visible || !focused) return null;
    if (focused === this.prompt) return "git-prompt";
    if ([this.history.root, this.files.root, this.refs.root, this.details, this.diffFocus].some((target) => within(focused, target))) return "git";
    return null;
  }
  get context(): GitContext | null {
    const cache = this.cache, focus = this.renderer.currentFocusedRenderable;
    if (!cache?.data || !focus || this.dialog.visible) return null;
    if (within(focus, this.diffFocus) || within(focus, this.files.root)) return this.selectedFile ? fileContext(this.selectedFile) : null;
    if (within(focus, this.details)) return cache.details ? detailsContext(cache.details, cache.data.refs) : null;
    if (within(focus, this.refs.root)) {
      const ref = cache.data.refs.find((item) => item.ref === cache.state.refSelected); return ref ? refContext(ref) : null;
    }
    if (within(focus, this.history.root)) {
      if (cache.state.tab === "reflog") { const event = cache.data.reflog.find((item) => item.selector === cache.state.reflogSelected); return event ? reflogContext(event) : null; }
      const commit = cache.data.commits.find((item) => item.oid === cache.state.selected); return commit ? commitContext(commit) : null;
    }
    return null;
  }
  get shortcuts(): FooterShortcut[] {
    const context = this.keyContext() ?? "git";
    const hint = (command: CommandId, label: string) => ({ key: this.hint(command, context), label });
    if (context === "git-prompt") return [hint("git.submit", "Send"), hint("git.cancel", "Cancel")];
    const target = this.context;
    return [...(target ? [hint("git.ask", `Ask ${target.label.split(" ")[0]!.toLowerCase()}`), hint("git.copy", target.label.startsWith("File") ? "Copy path" : target.label.startsWith("Branch") || target.label.startsWith("Tag") ? "Copy name" : "Copy hash")] : []),
      hint("git.open", "Select"), hint("git.refresh", "Refresh"), ...(this.cache?.state.tab === "commits" && this.cache.state.diff ? [hint("git.back", "Commits")] : [])];
  }
  show(worktree: Worktree | null, sessionId: string | null): void {
    if (this.disposed || this.root.isDestroyed) return;
    this.sessionId = sessionId;
    if (this.root.visible && this.worktree?.id === worktree?.id) { this.worktree = worktree; return; }
    this.hide(); this.worktree = worktree; this.root.visible = true; this.generation++;
    if (worktree && this.actions && !this.caches.has(worktree.id)) this.caches.set(worktree.id, {
      state: structuredClone(this.initial[worktree.id] ?? initialGitState()), source: this.actions.source(worktree),
    });
    this.pendingRestore = true; this.render();
    if (worktree && this.actions && !this.cache?.data) this.refresh();
    else if (this.cache?.state.selected && !this.cache.details) this.launch(() => this.loadDetails(this.cache!));
    else if (this.cache?.state.diff && !this.cache.comparison && !this.cache.diffError && this.selectedFile) this.openDiff(false);
  }
  hide(): void {
    if (!this.root.visible) return;
    this.remember(); this.generation++;
    for (const request of this.requests) request.abort(); this.requests.clear(); this.spinner.cancel();
    if (this.root.isDestroyed) { this.ask = undefined; return; }
    if (this.ask) this.closeAsk(false);
    if (within(this.renderer.currentFocusedRenderable, this.root)) this.renderer.currentFocusedRenderable?.blur();
    this.root.visible = false;
  }
  private launch(operation: () => Promise<void>): void {
    void operation().catch((error: unknown) => { if (!this.disposed) this.notice(reportUnexpected(error, "Git view")); });
  }
  private request(): AbortController { const request = new AbortController(); this.requests.add(request); this.spinner.start(); return request; }
  private finished(request: AbortController): void { this.requests.delete(request); if (!this.requests.size) this.spinner.stop(); }
  private current(cache: Cache, generation: number, request: AbortController): boolean { return !this.disposed && !this.root.isDestroyed && this.root.visible && this.cache === cache && this.generation === generation && !request.signal.aborted; }
  private failure(error: ExpectedError): void { if (!(error instanceof CancelledError)) this.notice(`[${error.code}] ${error.message}`); }
  refresh(): void {
    const cache = this.cache; if (!cache) return;
    this.remember(); this.loadRequest?.abort();
    const request = this.request(), generation = this.generation; this.loadRequest = request;
    this.launch(async () => {
      try {
        const result = await cache.source.load(cache.state.reference, cache.state.limit, request.signal);
        if (!this.current(cache, generation, request)) return;
        if (!result.ok) { cache.error = `[${result.error.code}] ${result.error.message}`; this.failure(result.error); this.render(); return; }
        cache.error = undefined; cache.data = result.value;
        if (cache.state.selected && !result.value.commits.some((commit) => commit.oid === cache.state.selected)) cache.state.selected = null;
        cache.details = undefined; cache.comparison = undefined; cache.diffError = undefined;
        this.pendingRestore = true; this.render();
        if (cache.state.selected) await this.loadDetails(cache);
        else if (cache.state.diff && this.selectedFile) this.openDiff(false);
      } finally { this.finished(request); }
    });
  }
  private more(): void { if (this.cache && this.cache.state.limit < 3000) { this.cache.state.limit += 300; this.persist(); this.refresh(); } }
  private setTab(tab: GitViewState["tab"]): void {
    if (!this.cache) return;
    this.remember(); this.cache.state.tab = tab; this.pendingRestore = true; this.persist(); this.render(); this.history.root.focus();
  }
  private filter(reference: string | null): void {
    if (!this.cache) return;
    this.remember(); Object.assign(this.cache.state, { reference, selected: null, file: null, diff: false, limit: 300, historyScroll: 0 });
    this.cache.details = undefined; this.persist(); this.refresh();
  }
  private chooseHistory(key: string): void {
    const cache = this.cache; if (!cache) return;
    cache.state.historyScroll = Math.max(0, Math.round(this.history.root.scrollTop));
    if (cache.state.tab === "reflog") { cache.state.reflogSelected = key; this.persist(); this.changed(); return; }
    if (cache.state.selected === key) return;
    cache.state.selected = key === workingKey ? null : key; cache.state.diff = false; cache.state.file = null;
    cache.state.detailsScroll = 0; cache.state.filesScroll = 0;
    cache.details = undefined; cache.comparison = undefined; cache.diffError = undefined;
    this.persist(); this.render();
    if (cache.state.selected) this.launch(() => this.loadDetails(cache));
  }
  private async loadDetails(cache: Cache): Promise<void> {
    const commit = cache.data?.commits.find((item) => item.oid === cache.state.selected); if (!commit) return;
    this.detailRequest?.abort(); const request = this.request(), generation = this.generation; this.detailRequest = request;
    try {
      const result = await cache.source.details(commit, request.signal);
      if (!this.current(cache, generation, request) || cache.state.selected !== commit.oid) return;
      if (!result.ok) { cache.error = `[${result.error.code}] ${result.error.message}`; this.failure(result.error); this.render(); return; }
      cache.details = result.value; cache.error = undefined; this.pendingRestore = true; this.render();
      if (cache.state.diff && this.selectedFile) this.openDiff(false);
    } finally { this.finished(request); }
  }
  private openDiff(focus = true): void {
    const cache = this.cache, file = this.selectedFile; if (!cache || !file) return;
    cache.state.diff = true; cache.comparison = undefined; cache.diffError = undefined;
    if (focus) cache.state.diffScroll = 0;
    this.diffRequest?.abort(); const request = this.request(), generation = this.generation; this.diffRequest = request;
    this.persist(); this.render(); if (focus) this.diffFocus.focus();
    this.launch(async () => {
      try {
        const result = await cache.source.compare(file, request.signal);
        if (!this.current(cache, generation, request) || cache.state.file !== fileKey(file)) return;
        if (!result.ok) { cache.diffError = `[${result.error.code}] ${result.error.message}`; this.failure(result.error); }
        else cache.comparison = result.value;
        this.pendingRestore = true; this.render();
      } finally { this.finished(request); }
    });
  }
  private back(): void {
    if (!this.cache) return;
    this.remember(); this.cache.state.diff = false; this.persist(); this.pendingRestore = true; this.render(); this.history.root.focus();
  }

  private render(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const cache = this.cache, data = cache?.data, state = cache?.state;
    this.title.content = this.worktree ? `Git · ${this.worktree.name}${state?.reference ? ` · ${display(state.reference)}` : " · All refs"}` : "Git · No workspace";
    this.status.content = !this.actions ? "Git preview · open a real repository to load Git data." : cache?.error ?? (!data ? "Loading Git data…"
      : state?.limit === 3000 && data.commits.length === 3000 ? "Showing 3,000 commits · narrow the ref filter to browse more history." : "");
    this.status.visible = !!this.status.content;
    this.body.visible = !!cache;
    if (!cache || !state) return;
    this.paintTabs();
    this.topButtons[3]!.visible = state.tab === "commits" && !!data && data.commits.length === state.limit && state.limit < 3000;
    this.right.visible = state.tab === "commits";
    this.commitPanel.visible = state.right === "commit"; this.refsPanel.visible = state.right === "refs";
    this.history.root.visible = state.tab === "reflog" || !state.diff;
    this.diffFocus.visible = state.tab === "commits" && state.diff;
    let history: GitListItem[] = [];
    if (state.tab === "reflog") {
      history = (data?.reflog ?? []).map((event) => ({ key: event.selector, label: display(`${event.selector}  ${event.oid.slice(0, 7)}  ${event.subject}`) }));
      state.reflogSelected ??= data?.reflog[0]?.selector ?? null;
    } else if (data) {
      const commits: GraphCommit[] = [...data.commits];
      if (!state.reference || state.reference === `refs/heads/${data.head}`) commits.unshift({ oid: workingKey, parents: data.headOid ? [data.headOid] : [],
        subject: `Working tree (${data.files.length})`, author: "", date: "", workingTree: true });
      const width = Math.max(5, Math.min(20, Math.floor((this.main.width || 60) * 0.3)));
      history = layoutGraph(commits, width).map((row) => {
        const labels = data.refs.filter((ref) => ref.oid === row.commit.oid).map((ref) => ref.name);
        if (row.commit.oid === data.headOid) labels.unshift(data.head ? `HEAD → ${data.head}` : "HEAD");
        return { key: row.commit.oid, label: display(`${row.commit.workingTree ? "" : row.commit.oid.slice(0, 7) + " "}${row.commit.subject}${labels.length ? ` [${labels.join(", ")}]` : ""}`), graph: row.node, connector: row.connector, color: row.color };
      });
    }
    this.history.update(history.length ? history : [{ key: "empty", label: data ? state.tab === "commits" ? "No commits" : "No reflog entries" : "Loading…", disabled: true }], state.tab === "reflog" ? state.reflogSelected : state.selected ?? workingKey);
    this.details.visible = !!state.selected;
    this.detailText.content = cache.details ? describeCommit(cache.details, data?.refs ?? []) : state.selected ? cache.error ?? "Loading commit details…" : "";
    const files = this.selectedFiles;
    if (state.file && !files.some((file) => fileKey(file) === state.file) && (!state.selected || cache.details)) { state.file = null; state.diff = false; }
    state.file ??= files[0] ? fileKey(files[0]) : null;
    this.filesTitle.content = `Changed files (${files.length})`;
    const fileRows: GitListItem[] = [];
    for (const kind of ["commit", "staged", "unstaged", "untracked"] as const) {
      const group = files.filter((file) => file.kind === kind);
      if (group.length && kind !== "commit") fileRows.push({ key: `heading:${kind}`, label: kind.toUpperCase(), disabled: true });
      for (const file of group) fileRows.push({ key: fileKey(file), label: display(`${file.status} ${file.path}`), color: file.status === "D" ? "error" : file.status === "A" || file.status === "?" ? "success" : "text" });
    }
    this.files.update(fileRows.length ? fileRows : [{ key: "empty", label: state.selected && !cache.details ? cache.error ?? "Loading files…" : "No changed files", disabled: true }], state.file);
    const references = data?.refs.filter((ref) => ref.kind === state.refs) ?? [];
    if (!references.some((ref) => ref.ref === state.refSelected)) state.refSelected = references[0]?.ref ?? null;
    this.refs.update(references.length ? references.map((ref) => ({ key: ref.ref, label: display(`${ref.kind === "local" && ref.name === data?.head ? "✓ " : ""}${ref.name}`) })) : [{ key: "empty", label: "No refs", disabled: true }], state.refSelected);
    this.history.root.visible = state.tab === "reflog" || !state.diff;
    this.diffFocus.visible = state.tab === "commits" && state.diff;
    this.renderDiff(); this.applyScroll(); this.persist(); this.changed();
  }
  private renderDiff(): void {
    const cache = this.cache; if (!cache || !this.diffFocus.visible) return;
    const comparison = cache.comparison;
    this.diffTitle.content = `Before / After · ${display(this.selectedFile?.path ?? "")}`;
    if (comparison && comparison === this.renderedComparison && this.diff) return;
    this.diff?.destroyRecursively(); this.diff = undefined; this.renderedComparison = undefined;
    this.diffNotice.visible = true;
    if (!comparison) { this.diffNotice.content = cache.diffError ?? "Loading file comparison…"; return; }
    const patch = fullFilePatch(comparison);
    if (!patch.ok) { this.diffNotice.content = patch.error.message; return; }
    if (!patch.value) { this.diffNotice.content = "Both file versions are empty (no text lines)."; return; }
    const colors = uiTheme(this.renderer).colors;
    this.syntax ??= SyntaxStyle.fromStyles({ default: { fg: colors.text }, keyword: { fg: colors.keyword },
      string: { fg: colors.success }, number: { fg: colors.number }, comment: { fg: colors.muted } }, this.renderer.nativeScene!);
    const extension = this.selectedFile?.path.split(".").at(-1)?.toLowerCase();
    const language = extension === "ts" ? "typescript" : extension === "tsx" ? "typescriptreact" : extension === "js" || extension === "jsx" ? "javascript" : extension === "md" ? "markdown" : extension === "zig" ? "zig" : undefined;
    this.diff = new DiffRenderable(this.renderer, { id: "git-file-diff", width: "100%", flexGrow: 1, minHeight: 0, diff: patch.value,
      view: "split", syncScroll: true, wrapMode: "none", showLineNumbers: true, syntaxStyle: this.syntax,
      fg: colors.text, contextBg: colors.panel, contextContentBg: colors.panel,
      lineNumberFg: colors.muted, lineNumberBg: colors.surface,
      addedBg: colors.added, addedContentBg: colors.added, addedLineNumberBg: colors.added, addedSignColor: colors.success,
      removedBg: colors.removed, removedContentBg: colors.removed, removedLineNumberBg: colors.removed, removedSignColor: colors.error,
      selectionBg: colors.selected, selectionFg: colors.text,
      ...(language ? { filetype: language } : {}), ...(this.actions?.treeSitterClient ? { treeSitterClient: this.actions.treeSitterClient } : {}) });
    this.diffBody.add(this.diff); this.diffNotice.visible = false; this.renderedComparison = comparison;
  }
  private codePanes(): CodeRenderable[] {
    const walk = (node: Renderable): CodeRenderable[] => node instanceof CodeRenderable ? [node] : node.getChildren().flatMap(walk);
    return this.diff ? walk(this.diff).sort((a, b) => a.x - b.x) : [];
  }
  private persist(): void { if (this.worktree && this.cache) this.saved(this.worktree.id, structuredClone(this.cache.state)); }
  private remember = (): void => {
    if (this.restoring || this.pendingRestore || !this.root.visible || !this.cache || this.root.isDestroyed) return;
    const state = this.cache.state;
    state.historyScroll = Math.max(0, Math.round(this.history.root.scrollTop)); state.filesScroll = Math.max(0, Math.round(this.files.root.scrollTop));
    state.refsScroll = Math.max(0, Math.round(this.refs.root.scrollTop)); state.detailsScroll = Math.max(0, Math.round(this.details.scrollTop));
    if (this.diff) state.diffScroll = this.codePanes()[0]?.scrollY ?? 0;
    this.persist();
  };
  private canRestore(): boolean {
    const cache = this.cache;
    return this.pendingRestore && this.root.visible && !this.root.isDestroyed && !!cache?.data
      && (!cache.state.selected || !!cache.details || !!cache.error);
  }
  private applyScroll = (): void => {
    if (!this.canRestore()) return;
    this.restoring = true;
    try {
      const state = this.cache!.state;
      // Prime unchanged geometry immediately and reapply after native resize
      // callbacks update each scroll range. Never restore against placeholders.
      this.history.root.scrollTo(state.historyScroll); this.files.root.scrollTo(state.filesScroll);
      this.refs.root.scrollTo(state.refsScroll); this.details.scrollTo(state.detailsScroll);
      for (const code of this.codePanes()) code.scrollY = state.diffScroll;
    } finally { this.restoring = false; }
  };
  private restoreScroll = (): void => {
    if (!this.canRestore()) return;
    // Native code-pane viewports are measured now; their scroll offset changes
    // drawing, unlike ScrollBox translations which were settled during layout.
    this.applyScroll(); this.pendingRestore = false;
  };

  command(command: CommandId): void {
    const focus = this.renderer.currentFocusedRenderable;
    const list = [this.history, this.files, this.refs].find((item) => within(focus, item.root));
    switch (command) {
      case "git.ask": this.openAsk(); return;
      case "git.copy": { const context = this.context; if (context) this.copy(context.copy); return; }
      case "git.submit": this.launch(() => this.submit()); return;
      case "git.cancel": this.closeAsk(); return;
      case "git.refresh": this.refresh(); return;
      case "git.more": this.more(); return;
      case "git.back": if (this.cache?.state.tab === "commits" && this.cache.state.diff) this.back(); return;
      case "git.open": list?.open(); return;
      case "git.previous": case "git.next": case "git.first": case "git.last":
        if (list) { list.move(command.slice(4) as "previous" | "next" | "first" | "last"); return; }
        break;
    }
    const down = command === "git.next" || command === "git.page-down";
    const page = command === "git.page-down" || command === "git.page-up";
    const delta = (down ? 1 : -1) * (page ? Math.max(1, this.main.height - 3) : 1);
    if (within(focus, this.diffFocus)) {
      const panes = this.codePanes(); const left = panes[0];
      if (left) {
        const x = Math.max(0, left.scrollX + (command === "git.right" ? 4 : -4));
        const y = command === "git.first" ? 0 : command === "git.last" ? left.maxScrollY : Math.max(0, Math.min(left.maxScrollY, left.scrollY + delta));
        for (const pane of panes) {
          if (command === "git.left" || command === "git.right") pane.scrollX = x;
          else pane.scrollY = y;
        }
      }
    } else if (focus === this.details) this.details.scrollBy(delta);
    else if (list && page) list.root.scrollBy(delta);
    this.remember();
  }
  available(command: CommandId): boolean {
    if (command === "git.ask" || command === "git.copy") return !!this.context;
    if (command === "git.submit") return !!this.ask && !this.ask.sending && !!this.prompt.value.trim();
    if (command === "git.cancel") return !!this.ask;
    return !!this.cache;
  }
  private openAsk(): void {
    const context = this.context;
    if (!context || !this.worktree || !this.actions) return;
    this.ask = { context: structuredClone(context), worktree: this.worktree, session: this.worktree.sessions.some((session) => session.id === this.sessionId) ? this.sessionId : null,
      owner: this.renderer.currentFocusedRenderable, sending: false };
    this.dialogContext.content = context.label;
    this.prompt.value = ""; this.updateTarget(); this.dialog.visible = true; this.prompt.focus(); this.changed();
  }
  private cycleSession(): void {
    if (!this.ask || this.ask.sending) return;
    const choices = [...(this.worktree?.sessions ?? []).map((session) => session.id), null];
    this.ask.session = choices[(choices.indexOf(this.ask.session) + 1) % choices.length]!; this.updateTarget();
  }
  private updateTarget(): void {
    if (!this.ask) return;
    const session = this.worktree?.sessions.find((item) => item.id === this.ask!.session);
    this.targetText.content = `Session: ${session ? display(session.name) : this.ask.session ? this.ask.session : "New session (create on Send)"}`;
  }
  private closeAsk(restoreFocus = true): void {
    const ask = this.ask; this.ask = undefined; this.dialog.visible = false;
    if (restoreFocus && ask?.owner && !ask.owner.isDestroyed) ask.owner.focus(); this.changed();
  }
  private async submit(): Promise<void> {
    const ask = this.ask, actions = this.actions;
    if (!ask || !actions || ask.sending || !this.prompt.value.trim()) return;
    const input = this.prompt.value;
    const text = gitPrompt(input, ask.context); ask.sending = true;
    try {
      if (!ask.session) {
        const created = await actions.createSession(ask.worktree.id);
        if (!created.ok) { this.failure(created.error); return; }
        ask.session = created.value; ask.createdSession = created.value;
      } else if (ask.session !== ask.createdSession && !(this.worktree?.id === ask.worktree.id ? this.worktree : ask.worktree).sessions.some((session) => session.id === ask.session)) {
        this.failure(new InputError("The selected session is not in this worktree.")); return;
      }
      const result = await actions.prompt(ask.session, text);
      if (!result.ok) { this.failure(result.error); return; }
      if (this.ask === ask && !this.disposed) {
        if (this.prompt.value === input) this.closeAsk();
        else this.notice("Request accepted · newer input retained");
      }
    } finally { ask.sending = false; if (this.ask === ask && !this.disposed) this.updateTarget(); }
  }
  private copy(text: string): void {
    this.launch(async () => { const result = await (this.actions?.copy ? this.actions.copy(text) : this.clipboard.copy(text)); if (result.ok) this.notice(result.value); else this.failure(result.error); });
  }
  private selectionFinished = (selection: Selection): void => {
    const pointer = this.pointer; this.pointer = undefined;
    if (!pointer?.moved || !this.root.visible || this.dialog.visible || !this.actions) return;
    if (selection.anchor.x < this.root.x || selection.anchor.x >= this.root.x + this.root.width || selection.anchor.y < this.root.y || selection.anchor.y >= this.root.y + this.root.height) return;
    const panes = this.codePanes();
    const pane = panes.find((code) => selection.anchor.x >= code.x && selection.anchor.x < code.x + code.width && selection.anchor.y >= code.y && selection.anchor.y < code.y + code.height);
    if (pane) {
      // Clamp the final range to its starting code pane before extracting text.
      this.renderer.updateSelection(pane, Math.max(pane.x, Math.min(pane.x + pane.width - 1, selection.focus.x)),
        Math.max(pane.y, Math.min(pane.y + pane.height - 1, selection.focus.y)), { finishDragging: true });
    }
    if (!pane) {
      const region = [this.history.root.viewport, this.files.root.viewport, this.refs.root.viewport, this.details.viewport].find((view) =>
        selection.anchor.x >= view.x && selection.anchor.x < view.x + view.width && selection.anchor.y >= view.y && selection.anchor.y < view.y + view.height);
      if (region) this.renderer.updateSelection(region, Math.max(region.x, Math.min(region.x + region.width - 1, selection.focus.x)),
        Math.max(region.y, Math.min(region.y + region.height - 1, selection.focus.y)), { finishDragging: true });
    }
    const text = (pane ? pane.getSelectedText() : selection.getSelectedText());
    if (text) this.copy(text);
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.disposed = true;
    this.renderer.off("selection", this.selectionFinished);
    for (const box of [this.history.root, this.files.root, this.refs.root, this.details]) {
      box.content.off("resize", this.applyScroll); box.viewport.off("resize", this.applyScroll);
    }
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "Git clipboard cleanup"));
    this.root.destroyRecursively(); this.syntax?.destroy();
  }
}
