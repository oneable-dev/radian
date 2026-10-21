import {
  BoxRenderable, CodeRenderable, DiffRenderable, InputRenderableEvents, ScrollBoxRenderable, SyntaxStyle, TextRenderable,
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
import { icons } from "../../icons.ts";
import { codeStyles, paintText, styleBackground, type StyleGroup } from "../../ui/theme-styles.ts";
import { GitClipboard } from "./clipboard.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import type { Button, ButtonFactory } from "../../ui/button.ts";
import { bindPanelSpacing, panelSpacing } from "../../ui/spacing.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { PromptInput } from "../../agents/ui/prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";

export type GitActions = {
  source(worktree: Worktree): GitSource;
  createSession(worktreeId: string): Promise<Result<string, ExpectedError>>;
  prompt(sessionId: string, text: string, images?: readonly string[]): Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
  treeSitterClient?: TreeSitterClient;
};
type Cache = { state: GitViewState; source: GitSource; data?: GitSnapshot; details?: GitDetails | undefined; comparison?: GitComparison | undefined; error?: string | undefined; diffError?: string | undefined };
type Ask = { context: GitContext; worktree: Worktree; session: string | null; createdSession?: string; owner: Renderable | null; sending: boolean };
const workingKey = "__working_tree__";
const refKinds = ["local", "remote", "tag"] as const;
const display = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
const within = (target: Renderable | null, parent: Renderable): boolean => {
  for (let current: Renderable | null = target; current; current = current.parent instanceof Renderable ? current.parent : null) if (current === parent) return true;
  return false;
};

export class GitPanel {
  readonly root: BoxRenderable;
  private readonly toolbar: BoxRenderable;
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
  private readonly filesHeader: BoxRenderable;
  private readonly filesTitle: TextRenderable;
  private readonly diffFocus: BoxRenderable;
  private readonly diffBody: BoxRenderable;
  private readonly diffNotice: TextRenderable;
  private readonly dialog: BoxRenderable;
  private readonly dialogContext: TextRenderable;
  private readonly targetText: TextRenderable;
  private readonly targetButton: BoxRenderable;
  private readonly prompt: PromptInput;
  private readonly topButtons: Button[] = [];
  private readonly rightButtons: Button[] = [];
  private readonly refButtons: Button[] = [];
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

  constructor(private readonly renderer: CliRenderer, private readonly actions: GitActions | undefined, button: ButtonFactory,
    private readonly notice: (message: string) => void, private readonly changed: () => void,
    private readonly saved: (id: string, state: GitViewState) => void, private readonly initial: Readonly<Record<string, GitViewState>>,
    private readonly hint: (command: CommandId, context: KeyContext) => string, private readonly inspect?: (content: DialogContent) => void) {
    const gitColors = uiTheme(renderer).colors;
    this.clipboard = new GitClipboard(renderer);
    this.root = new BoxRenderable(renderer, { id: "git-view", flexGrow: 1, minHeight: 0, minWidth: 0, paddingX: 1, flexDirection: "column", visible: false,
      // Restore against measured list/diff geometry before any viewport is presented.
      renderBefore: this.restoreScroll, onSizeChange: () => this.resizeAsk(),
      onMouseDown: (event) => { if (event.button === 0) this.pointer = { x: event.x, y: event.y, moved: false }; },
      onMouseDrag: (event) => { if (this.pointer && (this.pointer.x !== event.x || this.pointer.y !== event.y)) this.pointer.moved = true; } });
    this.toolbar = this.row(); this.toolbar.id = "git-toolbar"; this.toolbar.alignItems = "center"; this.toolbar.marginBottom = 1;
    for (const [index, label] of ["Commits", "Reflog"].entries()) {
      const control = button(label, () => this.setTab(index === 0 ? "commits" : "reflog"), label, "work-tab");
      this.topButtons.push(control); this.toolbar.add(control);
    }
    const activity = new BoxRenderable(renderer, { width: 1, height: 1, flexShrink: 0,
      flexDirection: "row", alignItems: "center", justifyContent: "center" });
    this.spinner = new LoadingSpinner(renderer, { id: "git-loading", fg: gitColors.accent });
    activity.add(this.spinner.root); this.toolbar.add(activity);
    this.root.add(this.toolbar);
    this.status = new TextRenderable(renderer, { id: "git-status", content: "", fg: gitColors.muted, height: 1, flexShrink: 0, selectable: false, wrapMode: "none" });
    this.root.add(this.status);
    this.body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "row" });
    this.main = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column",
      onSizeChange: () => { if (this.cache && this.root.visible) { this.remember(); this.pendingRestore = true; this.render(); } } });
    this.history = new GitList(renderer, "git-history", (key) => this.chooseHistory(key), () => {});
    this.main.add(this.history.root);
    this.diffFocus = new BoxRenderable(renderer, { id: "git-diff", flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", focusable: true, visible: false,
      onMouseDown: () => this.diffFocus.focus(), onMouseScroll: () => this.remember() });
    this.diffBody = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" });
    this.diffNotice = new TextRenderable(renderer, { content: "", fg: gitColors.muted, wrapMode: "word", selectable: false });
    this.diffBody.add(this.diffNotice); this.diffFocus.add(this.diffBody); this.main.add(this.diffFocus);
    this.right = new BoxRenderable(renderer, { id: "git-right", width: "38%", minWidth: 16, flexShrink: 0, minHeight: 0, paddingLeft: 1, flexDirection: "column", border: ["left"] });
    const rightTabs = this.row(); rightTabs.marginBottom = 1;
    for (const name of ["Commit", "Refs"] as const) {
      const control = button(name, () => this.setRight(name === "Commit" ? "commit" : "refs"), name, "work-tab");
      this.rightButtons.push(control); rightTabs.add(control);
    }
    this.right.add(rightTabs);
    this.commitPanel = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column" });
    this.details = new ScrollBoxRenderable(renderer, { id: "git-details", height: "40%", minHeight: 3, scrollX: false, onMouseDown: () => this.details.focus() });
    this.detailText = new TextRenderable(renderer, { id: "git-detail-text", content: "", fg: gitColors.text, width: "100%", wrapMode: "word", selectable: true });
    this.details.add(this.detailText); this.commitPanel.add(this.details);
    // A fixed box prevents text-node rounding after the percentage-height details from allocating an extra row.
    this.filesHeader = new BoxRenderable(renderer, { height: 1, flexShrink: 0, marginBottom: 1 });
    this.filesTitle = this.text("Changed files", "ui.muted"); this.filesHeader.add(this.filesTitle); this.commitPanel.add(this.filesHeader);
    this.files = new GitList(renderer, "git-files", (key) => {
      if (this.cache) { this.cache.state.file = key; this.persist(); this.changed(); if (this.cache.state.diff) this.openDiff(false); }
    }, () => { if (!this.cache?.state.diff) this.openDiff(false); });
    this.commitPanel.add(this.files.root); this.right.add(this.commitPanel);
    this.refsPanel = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column" });
    const refTabs = this.row(); refTabs.marginBottom = 1;
    for (const [index, label] of ["Local", "Remote", "Tags"].entries()) {
      const control = button(label, () => this.setRefs(refKinds[index]!), label, "work-tab");
      this.refButtons.push(control); refTabs.add(control);
    }
    this.refsPanel.add(refTabs);
    this.refs = new GitList(renderer, "git-refs", (key) => { if (this.cache) { this.cache.state.refSelected = key; this.persist(); this.changed(); } }, (key) => this.filter(key));
    this.refsPanel.add(this.refs.root); this.right.add(this.refsPanel);
    // Navigation labels share the content inset, without a second button indent.
    // Preserve the existing three-cell gap between labels after removing padding.
    for (const row of [this.toolbar, rightTabs, refTabs]) row.gap = 3;
    for (const control of [...this.topButtons, ...this.rightButtons, ...this.refButtons]) control.paddingX = 0;
    this.body.add(this.main); this.body.add(this.right); this.root.add(this.body);
    this.dialog = new BoxRenderable(renderer, { id: "git-ask", position: "absolute", left: 0, right: 0, bottom: 0, height: 10,
      zIndex: 100, border: true, borderColor: gitColors.accent, backgroundColor: gitColors.panel, paddingX: 1, flexDirection: "column", visible: false });
    this.dialog.add(this.text("Ask Agent · selected Git context", "ui.popupTitle"));
    this.dialogContext = new TextRenderable(renderer, { content: "", height: 2, wrapMode: "word", fg: gitColors.text, selectable: false }); this.dialog.add(this.dialogContext);
    const targetRow = this.row();
    this.targetText = this.text("Session: "); targetRow.add(this.targetText);
    this.targetButton = button("Change session", () => this.cycleSession(), "Choose session"); targetRow.add(this.targetButton); this.dialog.add(targetRow);
    this.prompt = new PromptInput(renderer, notice, (content) => inspect?.(content)); this.prompt.id = "git-prompt";
    this.prompt.width = "100%"; this.prompt.placeholder = "Prompt · Enter to send"; this.dialog.add(this.prompt);
    this.prompt.on(InputRenderableEvents.INPUT, this.resizeAsk); this.prompt.on("resize", this.resizeAsk);
    const dialogControls = this.row();
    const send = button("Send", () => this.launch(() => this.submit()), "Send Git context");
    const cancel = button("Cancel", () => this.closeAsk(), "Cancel request");
    this.dialogButtons.push(this.targetButton, this.prompt, send, cancel); dialogControls.add(send); dialogControls.add(cancel); dialogControls.add(this.prompt.activity.root);
    this.dialog.add(dialogControls); this.root.add(this.dialog);
    bindPanelSpacing(renderer, this.root);
    renderer.on("selection", this.selectionFinished);
    for (const box of [this.history.root, this.files.root, this.refs.root, this.details]) {
      box.verticalScrollBar.on("change", this.remember);
      box.content.on("resize", this.applyScroll); box.viewport.on("resize", this.applyScroll);
    }
    const theme = uiTheme(renderer);
    theme.input(this.prompt); theme.scrollbars(this.details); theme.focusBorder(this.right);
    theme.bindStyles(this.root, (styles) => {
      paintText(this.spinner.root, styles["status.working"]); paintText(this.status, styles["ui.muted"]); paintText(this.diffNotice, styles["ui.muted"]);
      this.dialog.borderColor = styles["ui.popupBorder"].fg; this.dialog.backgroundColor = styles["ui.popup"].bg;
      paintText(this.detailText, styles["ui.label"]);
      this.detailText.selectionBg = styles["ui.selection"].bg; this.detailText.selectionFg = styles["ui.selection"].fg;
      paintText(this.dialogContext, styles["ui.label"]); this.paintTabs();
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
  private text(content: string, role: StyleGroup = "ui.label"): TextRenderable {
    const text = new TextRenderable(this.renderer, { content, height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    uiTheme(this.renderer).bindStyles(text, (styles) => paintText(text, styles[role]));
    return text;
  }
  private paintTabs(): void {
    const state = this.cache?.state;
    if (!state) return;
    this.topButtons[0]!.active = state.tab === "commits";
    this.topButtons[1]!.active = state.tab === "reflog";
    this.rightButtons[0]!.active = state.right === "commit";
    this.rightButtons[1]!.active = state.right === "refs";
    for (const [index, kind] of refKinds.entries()) this.refButtons[index]!.active = state.refs === kind;
  }
  get modal(): boolean { return this.dialog.visible; }
  focus(): void { if (this.root.visible && this.cache) this.history.root.focus(); }
  private get cache(): Cache | undefined { return this.worktree ? this.caches.get(this.worktree.id) : undefined; }
  private get canLoadMore(): boolean {
    const cache = this.cache;
    return !!cache && cache.state.tab === "commits" && !cache.state.diff && cache.state.limit < 3000 && cache.data?.commits.length === cache.state.limit;
  }
  private get canGoBack(): boolean {
    const state = this.cache?.state;
    return state?.tab === "commits" && (state.diff || state.right === "refs" || state.reference !== null);
  }
  private get selectedFiles(): GitFile[] { return this.cache?.state.selected ? this.cache.details?.files ?? [] : this.cache?.data?.files ?? []; }
  private get selectedFile(): GitFile | undefined { return this.selectedFiles.find((file) => fileKey(file) === this.cache?.state.file); }
  get focusTargets(): Renderable[] {
    if (this.dialog.visible) return this.dialogButtons;
    return [...this.topButtons.filter((control) => this.visible(control)), this.cache?.state.diff && this.cache.state.tab === "commits" ? this.diffFocus : this.history.root,
      ...(this.right.visible ? [...this.rightButtons, ...(this.commitPanel.visible ? [...(this.details.visible ? [this.details] : []), this.files.root]
        : [...this.refButtons, this.refs.root])] : [])];
  }
  private visible(target: Renderable): boolean { for (let node: Renderable | null = target; node; node = node.parent as Renderable | null) if (!node.visible) return false; return true; }
  private tabGroup(): Button[] | undefined {
    return [this.topButtons, this.rightButtons, this.refButtons].find(group => group.some(control => control.focused && this.visible(control)));
  }
  keyContext(): KeyContext | null {
    const focused = this.renderer.currentFocusedRenderable;
    if (!this.root.visible || !focused) return null;
    if (focused === this.prompt) return "git-prompt";
    if (!this.dialog.visible && this.tabGroup()) return "git-tabs";
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
    const context = this.keyContext() ?? "button";
    const hint = (command: CommandId, label: string) => ({ key: this.hint(command, context), label });
    if (context === "git-prompt") return [hint("git.submit", "Send"), hint("git.newline", "New line"), ...(this.prompt.canInspect ? [hint("git.inspect", "Inspect")] : []), hint("git.cancel", "Cancel")];
    if (context === "git-tabs") return [hint("button.activate", "Select"),
      { key: [this.hint("git.tab-previous", context), this.hint("git.tab-next", context)].filter(Boolean).join("/"), label: "Tabs" },
      ...(this.canGoBack ? [hint("git.back", "Back")] : [])];
    const target = this.context;
    return [...(target ? [hint("git.ask", `Ask ${target.label.split(" ")[0]!.toLowerCase()}`), hint("git.copy", target.label.startsWith("File") ? "Copy path" : target.label.startsWith("Branch") || target.label.startsWith("Tag") ? "Copy name" : "Copy hash")] : []),
      hint(context === "button" ? "button.activate" : "git.open", "Select"), hint("git.half-page-down", "½ page"), hint("git.refresh", "Refresh"), ...(this.canGoBack ? [hint("git.back", "Back")] : [])];
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
  private more(): void {
    const cache = this.cache; if (!cache || !this.canLoadMore) return;
    cache.state.limit = Math.min(3000, cache.state.limit + 300); this.persist(); this.refresh();
  }
  private setTab(tab: GitViewState["tab"]): void {
    if (!this.cache) return;
    this.remember(); this.cache.state.tab = tab; this.pendingRestore = true; this.persist(); this.render(); this.history.root.focus();
  }
  private setRight(tab: GitViewState["right"]): void {
    if (!this.cache) return;
    this.remember(); this.cache.state.right = tab; this.persist(); this.render();
  }
  private setRefs(kind: GitViewState["refs"]): void {
    if (!this.cache) return;
    this.remember(); this.cache.state.refs = kind; this.persist(); this.render();
  }
  private moveTab(direction: -1 | 1): void {
    const group = this.tabGroup(); if (!group) return;
    const current = group.findIndex(control => control.focused);
    const index = Math.max(0, Math.min(group.length - 1, current + direction));
    if (group === this.topButtons) this.setTab(index === 0 ? "commits" : "reflog");
    else if (group === this.rightButtons) this.setRight(index === 0 ? "commit" : "refs");
    else this.setRefs(refKinds[index]!);
    // Keep subsequent navigation within the same strip instead of jumping to its content.
    group[index]?.focus();
  }
  private filter(reference: string | null): void {
    if (!this.cache) return;
    this.remember(); Object.assign(this.cache.state, { reference, selected: null, file: null, diff: false, limit: 300, historyScroll: 0 });
    this.cache.details = undefined; this.pendingRestore = true; this.persist(); this.refresh();
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
    this.remember();
    if (this.cache.state.diff) this.cache.state.diff = false;
    else {
      this.cache.state.right = "commit";
      if (this.cache.state.reference !== null) { this.filter(null); this.render(); this.history.root.focus(); return; }
    }
    this.persist(); this.pendingRestore = true; this.render(); this.history.root.focus();
  }

  private render(): void {
    if (this.disposed || this.root.isDestroyed) return;
    const cache = this.cache, data = cache?.data, state = cache?.state;
    const status = !this.actions ? "Git preview · open a real repository to load Git data." : cache?.error ?? (!data ? ""
      : state?.limit === 3000 && data.commits.length === 3000 ? "Showing 3,000 commits · narrow the ref filter to browse more history." : "");
    this.status.content = status; this.status.visible = Boolean(status);
    this.body.visible = !!cache;
    if (!cache || !state) return;
    this.paintTabs();
    this.right.visible = state.tab === "commits";
    const { horizontal } = panelSpacing(this.renderer);
    this.right.paddingLeft = horizontal; this.dialog.paddingX = horizontal;
    this.commitPanel.visible = state.right === "commit"; this.refsPanel.visible = state.right === "refs";
    this.history.root.visible = state.tab === "reflog" || !state.diff;
    this.diffFocus.visible = state.tab === "commits" && state.diff;
    let history: GitListItem[] = [];
    if (state.tab === "reflog") {
      history = (data?.reflog ?? []).map((event): GitListItem => ({ key: event.selector, label: [
        { text: display(`${event.selector}  `) }, { text: event.oid.slice(0, 7), color: "git.hash" }, { text: display(`  ${event.subject}`) },
      ] }));
      state.reflogSelected ??= data?.reflog[0]?.selector ?? null;
    } else if (data) {
      const commits: GraphCommit[] = [...data.commits];
      if (!state.reference || state.reference === `refs/heads/${data.head}`) commits.unshift({ oid: workingKey, parents: data.headOid ? [data.headOid] : [],
        subject: `Working tree (${data.files.length})`, author: "", date: "", workingTree: true });
      const width = Math.max(5, Math.min(20, Math.floor((this.main.width || 60) * 0.3)));
      history = layoutGraph(commits, width).map((row): GitListItem => {
        const labels = data.refs.filter((ref) => ref.oid === row.commit.oid).map((ref) => ref.name);
        if (row.commit.oid === data.headOid) labels.unshift(data.head ? `HEAD → ${data.head}` : "HEAD");
        const subject = display(`${row.commit.subject}${labels.length ? ` [${labels.join(", ")}]` : ""}`);
        return { key: row.commit.oid, label: row.commit.workingTree ? subject : [
          { text: `${row.commit.oid.slice(0, 7)} `, color: row.color }, { text: subject },
        ], graph: row.node, connector: row.connector };
      });
    }
    this.history.update(history.length ? history : [{ key: "empty", label: data ? state.tab === "commits" ? "No commits" : "No reflog entries" : "Loading…", disabled: true }], state.tab === "reflog" ? state.reflogSelected : state.selected ?? workingKey);
    this.details.visible = !!state.selected;
    this.filesHeader.marginTop = this.details.visible ? 1 : 0;
    this.detailText.content = cache.details ? describeCommit(cache.details, data?.refs ?? []) : state.selected ? cache.error ?? "Loading commit details…" : "";
    const files = this.selectedFiles;
    if (state.file && !files.some((file) => fileKey(file) === state.file) && (!state.selected || cache.details)) { state.file = null; state.diff = false; }
    state.file ??= files[0] ? fileKey(files[0]) : null;
    this.filesTitle.content = `Changed files (${files.length})`;
    const fileRows: GitListItem[] = [];
    for (const kind of ["commit", "staged", "unstaged", "untracked"] as const) {
      const group = files.filter((file) => file.kind === kind);
      if (group.length && kind !== "commit") fileRows.push({ key: `heading:${kind}`, label: kind.toUpperCase(), disabled: true, gapBefore: fileRows.length > 0 });
      for (const file of group) fileRows.push({ key: fileKey(file),
        label: file.status === "M" ? [{ text: "M", color: "git.modified" }, { text: display(` ${file.path}`) }] : display(`${file.status} ${file.path}`),
        color: file.status === "D" ? "git.removed" : file.status === "A" || file.status === "?" ? "git.added" : "ui.label" });
    }
    this.files.update(fileRows.length ? fileRows : [{ key: "empty", label: state.selected && !cache.details ? cache.error ?? "Loading files…" : "No changed files", disabled: true }], state.file);
    const references = data?.refs.filter((ref) => ref.kind === state.refs) ?? [];
    if (!references.some((ref) => ref.ref === state.refSelected)) state.refSelected = references[0]?.ref ?? null;
    this.refs.update(references.length ? references.map((ref): GitListItem => ({ key: ref.ref,
      label: display(`${ref.kind === "tag" ? icons.tag : icons.branch} ${ref.name}`),
      color: ref.kind === "local" && ref.name === data?.head ? "git.currentRef" : "ui.label",
    })) : [{ key: "empty", label: "No refs", disabled: true }], state.refSelected);
    this.history.root.visible = state.tab === "reflog" || !state.diff;
    this.diffFocus.visible = state.tab === "commits" && state.diff;
    this.renderDiff(); this.applyScroll(); this.persist(); this.changed();
  }
  private renderDiff(): void {
    const cache = this.cache; if (!cache || !this.diffFocus.visible) return;
    const comparison = cache.comparison;
    if (comparison && comparison === this.renderedComparison && this.diff) return;
    this.diff?.destroyRecursively(); this.diff = undefined; this.renderedComparison = undefined;
    this.diffNotice.visible = true;
    if (!comparison) { this.diffNotice.content = cache.diffError ?? "Loading file comparison…"; return; }
    const patch = fullFilePatch(comparison);
    if (!patch.ok) { this.diffNotice.content = patch.error.message; return; }
    if (!patch.value) { this.diffNotice.content = "Both file versions are empty (no text lines)."; return; }
    const styles = uiTheme(this.renderer).styles;
    this.syntax ??= SyntaxStyle.fromStyles(codeStyles(styles), this.renderer.nativeScene!);
    const extension = this.selectedFile?.path.split(".").at(-1)?.toLowerCase();
    const language = extension === "ts" ? "typescript" : extension === "tsx" ? "typescriptreact" : extension === "js" || extension === "jsx" ? "javascript" : extension === "md" ? "markdown" : extension === "zig" ? "zig" : undefined;
    this.diff = new DiffRenderable(this.renderer, { id: "git-file-diff", width: "100%", flexGrow: 1, minHeight: 0, diff: patch.value,
      view: "split", syncScroll: true, wrapMode: "none", showLineNumbers: true, syntaxStyle: this.syntax,
      fg: styles["syntax.text"].fg, contextBg: styleBackground(styles["ui.text"]), contextContentBg: styleBackground(styles["ui.text"]),
      lineNumberFg: styles["diff.lineNumber"].fg, lineNumberBg: styleBackground(styles["diff.lineNumber"]),
      addedBg: styleBackground(styles["diff.added"]), addedContentBg: styleBackground(styles["diff.added"]), addedLineNumberBg: styleBackground(styles["diff.added"]), addedSignColor: styles["diff.added"].fg,
      removedBg: styleBackground(styles["diff.removed"]), removedContentBg: styleBackground(styles["diff.removed"]), removedLineNumberBg: styleBackground(styles["diff.removed"]), removedSignColor: styles["diff.removed"].fg,
      selectionBg: styleBackground(styles["ui.selection"]), selectionFg: styles["ui.selection"].fg,
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
      case "git.newline": this.prompt.newLine(); return;
      case "git.paste": this.launch(() => this.prompt.pasteClipboard()); return;
      case "git.inspect": this.prompt.inspectAtCursor(); return;
      case "git.cancel": this.closeAsk(); return;
      case "git.refresh": this.refresh(); return;
      case "git.more": this.more(); return;
      case "git.back": if (this.canGoBack) this.back(); return;
      case "git.tab-previous": this.moveTab(-1); return;
      case "git.tab-next": this.moveTab(1); return;
      case "git.open": list?.open(); return;
      case "git.previous": case "git.next": case "git.first": case "git.last":
        if (list) { list.move(command.slice(4) as "previous" | "next" | "first" | "last"); return; }
        break;
      case "git.half-page-up": case "git.half-page-down":
        if (list) { list.moveHalfPage(command === "git.half-page-up" ? -1 : 1); return; }
        break;
    }
    const half = command === "git.half-page-up" || command === "git.half-page-down";
    const down = command === "git.next" || command === "git.page-down" || command === "git.half-page-down";
    const page = command === "git.page-down" || command === "git.page-up";
    const height = within(focus, this.diffFocus) ? this.codePanes()[0]?.height ?? this.diffFocus.height : this.details.viewport.height;
    const delta = (down ? 1 : -1) * (half ? halfPageStep(height) : page ? Math.max(1, this.main.height - 3) : 1);
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
    if (command === "git.tab-previous" || command === "git.tab-next") return this.root.visible && !this.dialog.visible && !!this.cache && !!this.tabGroup();
    if (command === "git.more") return this.root.visible && this.canLoadMore;
    if (command === "git.back") return this.root.visible && !this.dialog.visible && within(this.renderer.currentFocusedRenderable, this.root) && this.canGoBack;
    if (command === "git.left" || command === "git.right") return within(this.renderer.currentFocusedRenderable, this.diffFocus);
    if (command === "git.ask" || command === "git.copy") return !!this.context;
    if (command === "git.submit") return !!this.ask && !this.ask.sending && !this.prompt.pending && !!this.prompt.value.trim();
    if (command === "git.newline" || command === "git.paste") return !!this.ask;
    if (command === "git.inspect") return !!this.ask && !!this.inspect && this.prompt.canInspect;
    if (command === "git.cancel") return !!this.ask;
    return !!this.cache;
  }
  private openAsk(): void {
    const context = this.context;
    if (!context || !this.worktree || !this.actions) return;
    this.ask = { context: structuredClone(context), worktree: this.worktree, session: this.worktree.sessions.some((session) => session.id === this.sessionId) ? this.sessionId : null,
      owner: this.renderer.currentFocusedRenderable, sending: false };
    this.dialogContext.content = context.label;
    this.prompt.setWorkingDirectory(this.worktree.path); this.prompt.value = ""; this.updateTarget(); this.dialog.visible = true; this.resizeAsk(); this.prompt.focus(); this.changed();
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
    const ask = this.ask; this.ask = undefined; this.dialog.visible = false; this.prompt.cancelPaste();
    if (restoreFocus && ask?.owner && !ask.owner.isDestroyed) ask.owner.focus(); this.changed();
  }
  private async submit(): Promise<void> {
    const ask = this.ask, actions = this.actions;
    if (!ask || !actions || ask.sending || this.prompt.pending || !this.prompt.value.trim()) return;
    const fingerprint = () => { const draft = this.prompt.draft; return JSON.stringify([draft.value, draft.tokens]); };
    const input = fingerprint(), submission = this.prompt.submission;
    const text = gitPrompt(submission.text, ask.context); ask.sending = true;
    try {
      if (!ask.session) {
        const created = await actions.createSession(ask.worktree.id);
        if (!created.ok) { this.failure(created.error); return; }
        ask.session = created.value; ask.createdSession = created.value;
      } else if (ask.session !== ask.createdSession && !(this.worktree?.id === ask.worktree.id ? this.worktree : ask.worktree).sessions.some((session) => session.id === ask.session)) {
        this.failure(new InputError("The selected session is not in this worktree.")); return;
      }
      const result = submission.images.length ? await actions.prompt(ask.session, text, submission.images) : await actions.prompt(ask.session, text);
      if (!result.ok) { this.failure(result.error); return; }
      if (this.ask === ask && !this.disposed) {
        if (fingerprint() === input) this.closeAsk();
        else this.notice("Request accepted · newer input retained");
      }
    } finally { ask.sending = false; if (this.ask === ask && !this.disposed) this.updateTarget(); }
  }
  private resizeAsk = (): void => {
    if (this.disposed || !this.dialog?.visible || this.prompt.isDestroyed) return;
    const requested = Math.max(this.prompt.lineCount, this.prompt.editorView.getTotalVirtualLineCount());
    const rows = Math.max(1, Math.min(6, this.root.height - 9, requested));
    if (this.prompt.height !== rows) this.prompt.height = rows;
    const height = Math.min(this.root.height, 9 + rows);
    if (this.dialog.height !== height) this.dialog.height = height;
    this.changed();
  };
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
    this.prompt.off(InputRenderableEvents.INPUT, this.resizeAsk); this.prompt.off("resize", this.resizeAsk); this.prompt.dispose();
    for (const box of [this.history.root, this.files.root, this.refs.root, this.details]) {
      box.content.off("resize", this.applyScroll); box.viewport.off("resize", this.applyScroll);
    }
    void this.clipboard.dispose().catch((error: unknown) => reportUnexpected(error, "Git clipboard cleanup"));
    this.root.destroyRecursively(); this.syntax?.destroy();
  }
}
