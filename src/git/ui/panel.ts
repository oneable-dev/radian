import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  InputRenderableEvents,
  SyntaxStyle,
  TextRenderable,
  Renderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type Selection,
  type TreeSitterClient,
} from "@opentui/core";
import {
  CancelledError,
  GitError,
  InputError,
  reportUnexpected,
  type ExpectedError,
} from "../../errors.ts";
import { err, ok, type Result } from "../../result.ts";
import { layoutGraph, type GraphCommit } from "./graph.ts";
import {
  commitContext,
  describeCommit,
  fileContext,
  gitPrompt,
  type GitContext,
} from "../context.ts";
import {
  fileKey,
  initialGitState,
  type GitComparison,
  type GitDetails,
  type GitFile,
  type GitSnapshot,
  type GitSource,
  type GitViewState,
  type GitReflog,
} from "../model.ts";
import { fullFilePatch } from "../patch.ts";
import type { Worktree } from "../../workspace/model.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { GitList, type GitListItem } from "./list.ts";
import { GitBrowser, type GitBrowserKind } from "./browser.ts";
import type { Notice } from "../../ui/messages.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import {
  POPUP_SIZES,
  PopupBody,
  SearchPopupLayout,
  attachPopupActivity,
  centerPopup,
  getPopupSize,
} from "../../ui/popup-layout.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { createTextMatcher } from "../../search.ts";
import { icons } from "../../icons.ts";
import { codeStyles, paintText, styleBackground, type StyleGroup } from "../../ui/theme-styles.ts";
import { GitClipboard } from "./clipboard.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { bindPanelSpacing } from "../../ui/spacing.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { PromptInput } from "../../ui/prompt-input.ts";
import type { DialogContent } from "../../ui/text-dialog.ts";

export type GitActions = {
  source(worktree: Worktree): GitSource;
  createSession(worktreeId: string): Promise<Result<string, ExpectedError>>;
  prompt(
    sessionId: string,
    text: string,
    images?: readonly string[],
  ): Result<void, ExpectedError> | Promise<Result<void, ExpectedError>>;
  copy?(text: string): Promise<Result<string, ExpectedError>>;
  treeSitterClient?: TreeSitterClient;
};

type ExternalChange = {
  details: GitDetails;
  file: string | null;
  diffScroll: number;
  comparison: GitComparison | undefined;
  diffError: string | undefined;
};

type Cache = {
  state: GitViewState;
  source: GitSource;
  data?: GitSnapshot;
  details?: GitDetails | undefined;
  comparison?: GitComparison | undefined;
  external?: ExternalChange | undefined;
  error?: string | undefined;
  diffError?: string | undefined;
};

type Ask = {
  context: GitContext;
  worktree: Worktree;
  session: string | null;
  createdSession?: string;
  owner: Renderable | null;
  sending: boolean;
};

const workingKey = "__working_tree__";
const display = (value: string) =>
  value.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Render control characters as visible escapes, never terminal commands.
    /[\x00-\x1f\x7f-\x9f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
const within = (target: Renderable | null, parent: Renderable): boolean => {
  for (
    let current: Renderable | null = target;
    current;
    current = current.parent instanceof Renderable ? current.parent : null
  ) {
    if (current === parent) {
      return true;
    }
  }

  return false;
};

export class GitPanel {
  readonly root: BoxRenderable;
  private readonly toolbar: BoxRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly status: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly main: BoxRenderable;
  private readonly changes: BoxRenderable;
  private readonly changesOverlay: BoxRenderable;
  private readonly changesSearch: SearchInput;
  private readonly changesLayout: SearchPopupLayout;
  private readonly changesPreview: PopupBody;
  private readonly changesSpinner: LoadingSpinner;
  private readonly filterText: TextRenderable;
  private readonly browser: GitBrowser;
  private readonly history: GitList;
  private readonly files: GitList;
  private readonly filesBody: PopupBody;
  private readonly comparisonBody: PopupBody;
  private readonly sidebar: BoxRenderable;
  private readonly details: ScrollBoxRenderable;
  private readonly detailText: TextRenderable;
  private readonly summaryFiles: GitList;
  private readonly summaryFilesBody: PopupBody;
  private readonly filesTitle: TextRenderable;
  private readonly diffFocus: BoxRenderable;
  private readonly diffBody: BoxRenderable;
  private readonly diffNotice: TextRenderable;
  private readonly beforeTitle: TextRenderable;
  private readonly afterTitle: TextRenderable;
  private readonly dialog: BoxRenderable;
  private readonly dialogOverlay: BoxRenderable;
  private readonly prompt: PromptInput;
  private readonly clipboard: GitClipboard;
  private readonly caches = new Map<string, Cache>();
  private readonly requests = new Set<AbortController>();
  private worktree: Worktree | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  private loadRequest: AbortController | undefined;
  private detailRequest?: AbortController;
  private diffRequest?: AbortController;
  private diff: DiffRenderable | undefined;
  private syntax: SyntaxStyle | undefined;
  private renderedComparison: GitComparison | undefined;
  private ask: Ask | undefined;
  private disposed = false;
  private focused = false;
  private restoring = false;
  private pendingRestore = false;
  private compactPreview = false;
  private changesOwner: Renderable | undefined;
  private pointer: { x: number; y: number; moved: boolean } | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: GitActions | undefined,
    private readonly notice: Notice,
    private readonly changed: () => void,
    private readonly saved: (id: string, state: GitViewState) => void,
    private readonly initial: Readonly<Record<string, GitViewState>>,
    private readonly hint: (command: CommandId, context: KeyContext) => string,
    private readonly inspect?: (content: DialogContent) => void,
  ) {
    const gitColors = uiTheme(renderer).colors;
    this.clipboard = new GitClipboard(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "git-view",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      paddingX: 1,
      flexDirection: "column",
      visible: false,
      // Restore against measured list/diff geometry before any viewport is presented.
      renderBefore: this.beforeRender,
      onSizeChange: () => {
        this.resizeChanges();
        this.resizeAsk();
      },
      onMouseDown: (event) => {
        if (event.button === 0) {
          this.pointer = { x: event.x, y: event.y, moved: false };
        }
      },
      onMouseDrag: (event) => {
        if (this.pointer && (this.pointer.x !== event.x || this.pointer.y !== event.y)) {
          this.pointer.moved = true;
        }
      },
    });
    this.toolbar = this.row();
    this.toolbar.id = "git-toolbar";
    this.toolbar.marginBottom = 1;
    this.toolbar.visible = false;
    this.filterText = this.text("", "ui.muted");
    this.filterText.truncate = true;
    this.filterText.minWidth = 0;
    this.filterText.flexGrow = 1;
    this.toolbar.add(this.filterText);
    this.root.add(this.toolbar);

    const activity = new BoxRenderable(renderer, {
      position: "absolute",
      right: 2,
      top: 0,
      zIndex: 20,
      width: 1,
      height: 1,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "git-loading", fg: gitColors.accent });
    activity.add(this.spinner.root);
    this.root.add(activity);
    this.status = new TextRenderable(renderer, {
      id: "git-status",
      content: "",
      fg: gitColors.muted,
      height: 1,
      flexShrink: 0,
      selectable: false,
      wrapMode: "none",
    });
    this.root.add(this.status);
    this.body = new BoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "row",
    });
    this.main = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      overflow: "hidden",
      onSizeChange: () => {
        if (this.cache && this.root.visible) {
          this.remember();
          this.pendingRestore = true;
          this.render();
        }
      },
    });
    // Mouse selection stays in history; only Enter drills into the selected commit.
    this.history = new GitList(
      renderer,
      "git-history",
      (key) => this.chooseHistory(key),
      () => this.openChanges(),
      false,
    );
    this.main.add(this.history.root);
    this.sidebar = new BoxRenderable(renderer, {
      id: "git-sidebar",
      width: "35%",
      flexShrink: 0,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      border: ["left"],
      paddingLeft: 1,
    });
    const detailsPanel = new BoxRenderable(renderer, {
      id: "git-details-panel",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
    });
    detailsPanel.add(this.text("Commit details", "ui.muted"));
    this.details = new ScrollBoxRenderable(renderer, {
      id: "git-details",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      scrollX: false,
      onMouseDown: () => this.details.focus(),
    });
    this.detailText = new TextRenderable(renderer, {
      id: "git-detail-text",
      content: "",
      fg: gitColors.text,
      width: "100%",
      wrapMode: "word",
      selectable: true,
      flexShrink: 0,
    });
    this.details.add(this.detailText);
    detailsPanel.add(this.details);
    this.sidebar.add(detailsPanel);
    const summaryPanel = new BoxRenderable(renderer, {
      id: "git-summary-files-panel",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      border: ["top"],
    });
    this.filesTitle = this.text("Changed files", "ui.muted");
    summaryPanel.add(this.filesTitle);
    this.summaryFiles = new GitList(
      renderer,
      "git-summary-files",
      (key) => this.chooseFile(key),
      () => this.openChanges(),
      false,
    );
    this.summaryFilesBody = new PopupBody(
      renderer,
      "git-summary-files-body",
      this.summaryFiles.root,
    );
    summaryPanel.add(this.summaryFilesBody.root);
    this.sidebar.add(summaryPanel);
    this.body.add(this.main);
    this.body.add(this.sidebar);
    this.root.add(this.body);
    this.changesOverlay = new BoxRenderable(renderer, {
      id: "git-changes-overlay",
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      zIndex: 50,
      visible: false,
      onSizeChange: () => this.resizeChanges(),
    });
    this.changes = new PopupFrame(renderer, {
      id: "git-changes",
      position: "absolute",
      border: false,
      paddingX: 0,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "column",
      visible: false,
    });
    this.changesSpinner = new LoadingSpinner(renderer, {
      id: "git-changes-loading",
      fg: gitColors.accent,
    });
    attachPopupActivity(renderer, this.changes, this.changesSpinner.root, () => ({
      pending: this.requests.size > 0,
      hasContent:
        this.selectedFiles.length > 0 ||
        !!(this.cache?.details || this.cache?.external || this.cache?.error),
      message: "",
      title: this.changesSearch.field,
    }));

    this.changesSearch = new SearchInput(renderer, {
      id: "git-changes-search",
      title: "Changed files",
    });
    this.files = new GitList(
      renderer,
      "git-files",
      (key) => this.chooseFile(key),
      () => this.focusPreview(),
      false,
      "ui.popup",
    );
    this.diffFocus = new BoxRenderable(renderer, {
      id: "git-diff",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      focusable: true,
      onMouseDown: () => this.diffFocus.focus(),
      onMouseScroll: () => this.remember(),
    });

    const diffHeader = this.row();
    this.beforeTitle = this.text("Before", "ui.muted");
    this.beforeTitle.width = "50%";
    this.beforeTitle.minWidth = 0;
    this.beforeTitle.truncate = true;
    this.afterTitle = this.text("After", "ui.muted");
    this.afterTitle.width = "50%";
    this.afterTitle.minWidth = 0;
    this.afterTitle.truncate = true;
    diffHeader.gap = 0;
    diffHeader.add(this.beforeTitle);
    diffHeader.add(this.afterTitle);
    this.diffFocus.add(diffHeader);
    this.diffBody = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      overflow: "hidden",
    });
    this.diffNotice = new TextRenderable(renderer, {
      content: "",
      fg: gitColors.muted,
      wrapMode: "word",
      selectable: false,
    });
    this.diffBody.add(this.diffNotice);
    this.comparisonBody = new PopupBody(renderer, "git-comparison-body", this.diffBody);
    this.comparisonBody.root.flexBasis = 0;
    this.diffFocus.add(this.comparisonBody.root);
    this.changesPreview = new PopupBody(renderer, "git-changes-preview", this.diffFocus);
    this.changesLayout = new SearchPopupLayout(renderer, {
      id: "git-changes",
      search: this.changesSearch,
      list: this.files.root,
      preview: { body: this.changesPreview, width: 72 },
    });
    this.filesBody = this.changesLayout.results;
    this.changes.add(this.changesLayout.root);
    this.changesOverlay.add(this.changes);
    this.root.add(this.changesOverlay);
    this.changesSearch.on(InputRenderableEvents.INPUT, this.filterChanges);
    this.browser = new GitBrowser(renderer, {
      notice: this.notice,
      changed: () => {
        this.updateHistoryRail();
        this.changed();
      },
      close: () => this.closeBrowser(),
      selected: (kind, key) => {
        if (this.cache) {
          if (kind === "refs") {
            this.cache.state.refSelected = key;
          } else {
            this.cache.state.reflogSelected = key;
          }

          this.persist();
        }
      },
      filter: (ref) => {
        this.browser.hide();
        this.filter(ref);
        this.render();
        this.history.root.focus();
      },
      open: (details) => this.openExternal(details),
      inspect: (event, signal) => this.inspectEvent(event, signal),
      hint,
    });
    this.root.add(this.browser.root);
    this.dialogOverlay = new BoxRenderable(renderer, {
      id: "git-ask-overlay",
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      zIndex: 100,
      visible: false,
      onSizeChange: () => this.resizeAsk(),
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => event.stopPropagation(),
    });
    this.dialog = new PopupFrame(renderer, {
      id: "git-ask",
      position: "absolute",
      zIndex: 100,
      border: false,
      backgroundColor: gitColors.panel,
      flexDirection: "column",
      visible: false,
    });
    this.prompt = new PromptInput(renderer, notice, (content) => inspect?.(content), {
      id: "git-prompt",
      backgroundStyle: "ui.popup",
    });
    this.prompt.field.setTitle("Ask");
    this.dialog.add(this.prompt.field);
    this.prompt.on(InputRenderableEvents.INPUT, this.resizeAsk);
    this.prompt.on("resize", this.resizeAsk);
    this.prompt.on("line-info-change", this.resizeAsk);
    this.dialogOverlay.add(this.dialog);
    this.root.add(this.dialogOverlay);
    bindPanelSpacing(renderer, this.root);
    renderer.on("selection", this.selectionFinished);
    renderer.on("focused_renderable", this.keepFocus);
    renderer.on("focus", this.refreshOnFocus);
    for (const box of [this.history.root, this.files.root, this.details]) {
      box.verticalScrollBar.on("change", this.remember);
      box.content.on("resize", this.applyScroll);
      box.viewport.on("resize", this.applyScroll);
    }

    this.files.root.viewport.on("resize", this.revealFile);
    const theme = uiTheme(renderer);
    theme.scrollbars(this.details);
    theme.bindStyles(this.root, (styles) => {
      paintText(this.spinner.root, styles["status.working"]);
      paintText(this.changesSpinner.root, styles["status.working"]);
      paintText(this.status, styles["ui.muted"]);
      paintText(this.diffNotice, styles["ui.muted"]);
      for (const popup of [this.changes]) {
        popup.borderColor = styles["ui.popupBorder"].fg;
        popup.backgroundColor = styles["ui.popup"].bg;
      }

      this.dialog.borderColor = styles["ui.popupBorder"].fg;
      this.dialog.backgroundColor = styles["ui.popup"].bg;
      this.changesOverlay.backgroundColor = styles["ui.backdrop"].bg;
      this.dialogOverlay.backgroundColor = styles["ui.backdrop"].bg;
      this.changesPreview.root.borderColor = styles["ui.border"].fg;
      this.sidebar.borderColor = styles["ui.border"].fg;
      summaryPanel.borderColor = styles["ui.border"].fg;
      paintText(this.detailText, styles["ui.label"]);
      this.detailText.selectionBg = styles["ui.selection"].bg;
      this.detailText.selectionFg = styles["ui.selection"].fg;
      // Rebuild once with all diff colors, rather than invoking a full native rebuild for every color setter.
      if (this.diff) {
        this.remember();
        this.diff.destroyRecursively();
        this.diff = undefined;
        this.renderedComparison = undefined;
        this.pendingRestore = true;
      }

      this.syntax?.destroy();
      this.syntax = undefined;
      this.renderDiff();
    });
  }

  private row(): BoxRenderable {
    return new BoxRenderable(this.renderer, {
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      minWidth: 0,
    });
  }

  private text(content: string, role: StyleGroup = "ui.label"): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      content,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    uiTheme(this.renderer).bindStyles(text, (styles) => paintText(text, styles[role]));

    return text;
  }

  get modal(): boolean {
    return (
      this.root.visible && (this.dialog.visible || this.changes.visible || this.browser.visible)
    );
  }

  focus(): void {
    if (!this.root.visible || !this.cache) {
      return;
    }
    if (this.dialog.visible) {
      this.prompt.focus();
    } else if (this.changes.visible) {
      this.changesSearch.focus();
    } else if (this.browser.visible) {
      this.browser.search.focus();
    } else {
      this.history.root.focus();
    }
  }

  private get historyColumns(): { rail: number; graph: number } {
    const width = Math.max(1, Math.floor(this.main.width || this.renderer.width));

    return {
      rail: Math.min(24, Math.floor(width * 0.35)),
      graph: Math.max(1, Math.min(16, Math.floor(width * 0.15))),
    };
  }

  private updateHistoryRail(): void {
    if (!this.cache || this.root.isDestroyed || this.renderer.isDestroyed) {
      return;
    }

    this.history.setRefWidth(this.historyColumns.rail);
  }

  private get cache(): Cache | undefined {
    return this.worktree ? this.caches.get(this.worktree.id) : undefined;
  }

  private get canLoadMore(): boolean {
    const cache = this.cache;

    return (
      !!cache &&
      !this.modal &&
      !cache.state.diff &&
      cache.state.limit < 3000 &&
      cache.data?.commits.length === cache.state.limit
    );
  }

  private get canGoBack(): boolean {
    const state = this.cache?.state;

    return (
      !!state &&
      (this.modal ||
        state.reference !== null ||
        within(this.renderer.currentFocusedRenderable, this.sidebar))
    );
  }

  private get selectedFiles(): GitFile[] {
    return (
      this.cache?.external?.details.files ??
      (this.cache?.state.selected
        ? (this.cache.details?.files ?? [])
        : (this.cache?.data?.files ?? []))
    );
  }

  private get selectedFile(): GitFile | undefined {
    return this.selectedFiles.find((file) => fileKey(file) === this.cache?.state.file);
  }

  get search(): SearchInput | undefined {
    if (this.dialog.visible) {
      return undefined;
    }

    return this.changes.visible
      ? this.changesSearch
      : this.browser.visible
        ? this.browser.search
        : undefined;
  }

  get focusTargets(): Renderable[] {
    if (this.dialog.visible) {
      return [this.prompt];
    }
    if (this.changes.visible) {
      return [
        this.changesSearch,
        ...(this.files.root.visible ? [this.files.root] : []),
        ...(this.changesPreview.root.visible ? [this.diffFocus] : []),
      ];
    }
    if (this.browser.visible) {
      return this.browser.focusTargets;
    }

    return [this.history.root, this.details, this.summaryFiles.root];
  }

  moveFocus(direction: 1 | -1): void {
    if (this.browser.visible && !this.dialog.visible) {
      this.browser.moveFocus(direction);

      return;
    }

    const targets = this.changes.visible
      ? [this.changesSearch, this.files.root, this.diffFocus]
      : this.focusTargets;
    const index = targets.indexOf(this.renderer.currentFocusedRenderable!);
    const next = targets[(index + direction + targets.length) % targets.length];
    if (this.changes.visible) {
      this.compactPreview = next === this.diffFocus;
      this.resizeChanges();
    }

    next?.focus();
  }

  keyContext(): KeyContext | null {
    const focused = this.renderer.currentFocusedRenderable;
    if (!this.root.visible || !focused) {
      return null;
    }
    if (focused === this.prompt) {
      return "git-prompt";
    }
    if (focused === this.changesSearch) {
      return "git-search";
    }
    if (this.browser.visible && within(focused, this.browser.root)) {
      return this.browser.context;
    }
    if (
      [
        this.history.root,
        this.files.root,
        this.summaryFiles.root,
        this.details,
        this.diffFocus,
      ].some((target) => within(focused, target))
    ) {
      return "git";
    }

    return null;
  }

  get context(): GitContext | null {
    const cache = this.cache;
    const focus = this.renderer.currentFocusedRenderable;
    if (!cache?.data || !focus || this.dialog.visible) {
      return null;
    }
    if (
      within(focus, this.diffFocus) ||
      within(focus, this.files.root) ||
      within(focus, this.summaryFiles.root)
    ) {
      return this.selectedFile ? fileContext(this.selectedFile) : null;
    }
    // Commit details are read-only; copy/Ask remain available from the commit list.
    if (within(focus, this.details)) {
      return null;
    }
    if (this.browser.visible) {
      return this.browser.selectionContext;
    }
    if (within(focus, this.history.root)) {
      const commit = cache.data.commits.find((item) => item.oid === cache.state.selected);

      return commit ? commitContext(commit) : null;
    }

    return null;
  }

  get shortcuts(): FooterShortcut[] {
    const context = this.keyContext() ?? "button";
    const hint = (command: CommandId, label: string) => ({
      key: footerKeyHint(command, context, this.hint(command, context)),
      label,
    });
    if (context === "git-prompt") {
      const session = this.worktree?.sessions.find((session) => session.id === this.ask?.session);
      const target = display(session?.name ?? this.ask?.session ?? "New session");
      return [
        hint("git.submit", "Send"),
        hint("git.change-session", `Session: ${target}`),
        hint("git.newline", "New line"),
        ...(this.prompt.value ? [hint("git.clear", "Clear")] : []),
        ...(this.prompt.canInspect ? [hint("git.inspect", "Inspect")] : []),
        hint("git.cancel", "Cancel"),
      ];
    }
    if (this.browser.visible) {
      return this.browser.shortcuts;
    }

    const target = this.context;

    return [
      ...(!this.modal ? [hint("git.refs", "Refs"), hint("git.reflog", "Reflog")] : []),
      ...(target
        ? [
            hint("git.ask", `Ask ${target.label.split(" ")[0]!.toLowerCase()}`),
            hint(
              "git.copy",
              target.label.startsWith("File")
                ? "Copy path"
                : target.label.startsWith("Branch") || target.label.startsWith("Tag")
                  ? "Copy name"
                  : "Copy hash",
            ),
          ]
        : []),
      ...(within(this.renderer.currentFocusedRenderable, this.details) ||
      within(this.renderer.currentFocusedRenderable, this.diffFocus)
        ? []
        : [
            hint(
              context === "button" ? "button.activate" : "git.open",
              within(this.renderer.currentFocusedRenderable, this.history.root) ? "Open" : "Select",
            ),
          ]),
      hint("focus.next", "Pane"),
      ...(this.changes.visible ? [hint("git.preview", "Preview")] : []),
      hint("git.half-page-down", "½ page"),
      hint("git.refresh", "Refresh"),
      ...(this.canGoBack ? [hint("git.back", this.modal ? "Close" : "Back")] : []),
    ];
  }

  show(worktree: Worktree | null, sessionId: string | null): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    this.sessionId = sessionId;
    if (this.root.visible && this.worktree?.id === worktree?.id) {
      this.worktree = worktree;

      return;
    }

    this.hide();
    this.worktree = worktree;
    this.root.visible = true;
    this.generation++;
    if (worktree && this.actions && !this.caches.has(worktree.id)) {
      this.caches.set(worktree.id, {
        state: structuredClone(this.initial[worktree.id] ?? initialGitState()),
        source: this.actions.source(worktree),
      });
    }
    if (this.cache) {
      this.cache.state.tab = "commits";
      this.cache.state.right = "commit";
    }

    this.pendingRestore = true;
    this.render();
    if (worktree && this.actions) {
      this.refresh();
    }
  }

  hide(): void {
    if (!this.root.visible) {
      return;
    }

    this.remember();
    this.generation++;
    this.focused = false;
    for (const request of this.requests) {
      request.abort();
    }

    this.requests.clear();
    this.spinner.cancel();
    this.changesSpinner.cancel();
    if (this.root.isDestroyed) {
      this.ask = undefined;

      return;
    }
    if (this.ask) {
      this.closeAsk(false);
    }

    this.browser.hide();
    this.changesOwner = undefined;
    this.restoreExternal();
    this.persist();
    if (within(this.renderer.currentFocusedRenderable, this.root)) {
      this.renderer.currentFocusedRenderable?.blur();
    }

    this.root.visible = false;
  }

  private launch(operation: () => Promise<void>): void {
    void operation().catch((error: unknown) => {
      if (!this.disposed) {
        this.notice(reportUnexpected(error, "Git view"), { level: "error", source: "Git" });
      }
    });
  }

  private request(): AbortController {
    const request = new AbortController();
    this.requests.add(request);
    this.spinner.start();
    if (this.changes.visible) {
      this.changesSpinner.start();
    }

    return request;
  }

  private finished(request: AbortController): void {
    this.requests.delete(request);
    if (!this.requests.size) {
      this.spinner.stop();
      this.changesSpinner.stop();
    }
  }

  private current(cache: Cache, generation: number, request: AbortController): boolean {
    return (
      !this.disposed &&
      !this.root.isDestroyed &&
      this.root.visible &&
      this.cache === cache &&
      this.generation === generation &&
      !request.signal.aborted
    );
  }

  private failure(error: ExpectedError): void {
    if (!(error instanceof CancelledError)) {
      this.notice(`[${error.code}] ${error.message}`, { level: "error", source: "Git" });
    }
  }

  private refreshOnFocus = (): void => {
    // Showing the view and handing it focus can occur in the same activation.
    if (this.loadRequest && !this.loadRequest.signal.aborted) {
      return;
    }

    this.refresh();
  };

  refresh(): void {
    const cache = this.cache;
    if (!cache || this.disposed || this.root.isDestroyed || !this.root.visible) {
      return;
    }

    this.remember();
    this.loadRequest?.abort();
    this.detailRequest?.abort();
    this.diffRequest?.abort();

    const request = this.request();
    const generation = this.generation;

    this.loadRequest = request;
    this.launch(async () => {
      try {
        const result = await cache.source.load(
          cache.state.reference,
          cache.state.limit,
          request.signal,
        );
        if (!this.current(cache, generation, request)) {
          return;
        }
        if (!result.ok) {
          cache.error = `[${result.error.code}] ${result.error.message}`;
          this.failure(result.error);
          this.browser.update(cache.data, cache.error);
          this.render();

          return;
        }

        // Navigation may have started previews against the old snapshot while loading.
        this.detailRequest?.abort();
        this.diffRequest?.abort();
        cache.error = undefined;
        cache.data = result.value;
        if (
          cache.state.selected &&
          !result.value.commits.some((commit) => commit.oid === cache.state.selected)
        ) {
          cache.state.selected = null;
        }

        cache.details = undefined;
        cache.comparison = undefined;
        cache.diffError = undefined;
        if (cache.external) {
          cache.external.comparison = undefined;
          cache.external.diffError = undefined;
        }

        this.browser.update(result.value);
        this.pendingRestore = true;
        this.render();
        if (cache.state.selected) {
          this.launch(() => this.loadDetails(cache));
        } else if (cache.state.diff && this.selectedFile) {
          this.loadComparison();
        }
      } finally {
        if (this.loadRequest === request) {
          this.loadRequest = undefined;
        }

        this.finished(request);
      }
    });
  }

  private more(): void {
    const cache = this.cache;
    if (!cache || !this.canLoadMore) {
      return;
    }

    cache.state.limit = Math.min(3000, cache.state.limit + 300);
    this.persist();
    this.refresh();
  }

  private openBrowser(kind: GitBrowserKind): void {
    const cache = this.cache;
    if (!cache || this.modal) {
      return;
    }

    this.remember();
    this.browser.show(
      kind,
      cache.data,
      kind === "refs"
        ? (cache.state.refSelected ?? cache.state.reference)
        : cache.state.reflogSelected,
    );
    if (cache.error) {
      this.browser.update(cache.data, cache.error);
    }
  }

  private closeBrowser(): void {
    this.browser.hide();
    this.render();
    this.history.root.focus();
  }

  private async inspectEvent(
    event: GitReflog,
    signal: AbortSignal,
  ): Promise<Result<GitDetails, ExpectedError>> {
    const cache = this.cache;
    if (signal.aborted) {
      return err(new CancelledError());
    }
    if (!cache) {
      return err(new InputError("No Git worktree selected."));
    }
    if (cache.details?.commit.oid === event.oid) {
      return ok(cache.details);
    }
    if (cache.source.lookup) {
      return cache.source.lookup(event.oid, signal);
    }

    const commit = cache.data?.commits.find((commit) => commit.oid === event.oid);

    return commit
      ? cache.source.details(commit, signal)
      : err(
          new GitError(
            "GIT_PREVIEW_UNAVAILABLE",
            "This Git source cannot inspect commits outside its history snapshot.",
          ),
        );
  }

  private openExternal(details: GitDetails): void {
    const cache = this.cache;
    if (!cache || this.ask) {
      return;
    }

    this.remember();
    this.browser.hide();
    cache.external = {
      details,
      file: cache.state.file,
      diffScroll: cache.state.diffScroll,
      comparison: cache.comparison,
      diffError: cache.diffError,
    };
    cache.state.diff = true;
    cache.state.file = null;
    cache.state.diffScroll = 0;
    cache.comparison = undefined;
    cache.diffError = undefined;
    this.pendingRestore = true;
    this.persist();
    this.changesSearch.value = "";
    this.changesSearch.cursorOffset = 0;
    this.compactPreview = false;
    this.render();
    this.changesSearch.focus();
    if (this.selectedFile) {
      this.loadComparison();
    }
  }

  private restoreExternal(): void {
    const cache = this.cache;
    const external = cache?.external;
    if (!cache || !external) {
      return;
    }

    cache.state.file = external.file;
    cache.state.diffScroll = external.diffScroll;
    cache.state.diff = false;
    cache.comparison = external.comparison;
    cache.diffError = external.diffError;
    cache.external = undefined;
  }

  private filter(reference: string | null): void {
    if (!this.cache) {
      return;
    }

    this.remember();
    Object.assign(this.cache.state, {
      reference,
      selected: null,
      file: null,
      diff: false,
      limit: 300,
      historyScroll: 0,
    });
    this.detailRequest?.abort();
    this.diffRequest?.abort();
    this.cache.details = undefined;
    this.cache.comparison = undefined;
    this.cache.diffError = undefined;
    this.pendingRestore = true;
    this.persist();
    this.refresh();
  }

  private chooseHistory(key: string): void {
    const cache = this.cache;
    if (!cache) {
      return;
    }

    cache.state.historyScroll = Math.max(0, Math.round(this.history.root.scrollTop));

    const selected = key === workingKey ? null : key;
    if (cache.state.selected === selected) {
      return;
    }

    cache.state.selected = selected;
    cache.state.diff = false;
    cache.state.file = null;
    cache.state.detailsScroll = 0;
    cache.state.filesScroll = 0;
    cache.details = undefined;
    cache.comparison = undefined;
    cache.diffError = undefined;
    this.persist();
    this.render();
    if (cache.state.selected) {
      this.launch(() => this.loadDetails(cache));
    }
  }

  private async loadDetails(cache: Cache): Promise<void> {
    const commit = cache.data?.commits.find((item) => item.oid === cache.state.selected);
    if (!commit) {
      return;
    }

    this.detailRequest?.abort();

    const request = this.request();
    const generation = this.generation;

    this.detailRequest = request;
    try {
      const result = await cache.source.details(commit, request.signal);
      if (!this.current(cache, generation, request) || cache.state.selected !== commit.oid) {
        return;
      }
      if (!result.ok) {
        cache.error = `[${result.error.code}] ${result.error.message}`;
        this.failure(result.error);
        this.render();

        return;
      }

      cache.details = result.value;
      cache.error = undefined;
      this.pendingRestore = true;
      this.render();
      if (cache.state.diff && this.selectedFile) {
        this.loadComparison();
      }
    } finally {
      this.finished(request);
    }
  }

  private openChanges(): void {
    const cache = this.cache;
    if (!cache || !cache.data) {
      return;
    }

    this.changesOwner = this.renderer.currentFocusedRenderable ?? undefined;
    this.remember();
    cache.state.diff = true;
    cache.state.right = "commit";
    this.pendingRestore = true;
    this.persist();
    this.changesSearch.value = "";
    this.changesSearch.cursorOffset = 0;
    this.compactPreview = false;
    this.render();
    this.changesSearch.focus();
    if (this.selectedFile && !cache.comparison && !cache.diffError) {
      this.loadComparison();
    }
    if (this.requests.size) {
      this.changesSpinner.start();
    }
  }

  private chooseFile(key: string): void {
    const cache = this.cache;
    if (!cache || cache.state.file === key) {
      return;
    }

    this.remember();
    cache.state.file = key;
    cache.state.diffScroll = 0;
    cache.comparison = undefined;
    cache.diffError = undefined;
    this.pendingRestore = true;
    if (this.changes.visible) {
      this.revealFile();
      this.loadComparison();
    } else {
      this.render();
    }
  }

  private filterChanges = (): void => {
    const previous = this.cache?.state.file;
    this.render();
    if (this.changes.visible && this.selectedFile && previous !== this.cache?.state.file) {
      this.loadComparison();
    }
    this.revealFile();
  };

  private revealFile = (): void => {
    if (this.cache?.state.file && this.changes.visible && this.files.root.visible) {
      this.files.revealSelection();
      this.cache.state.filesScroll = this.files.root.scrollTop;
    }
  };

  private focusPreview(): void {
    this.compactPreview = true;
    this.resizeChanges();
    this.diffFocus.focus();
  }

  private resizeChanges = (): void => {
    if (!this.changesLayout || this.disposed || this.root.isDestroyed) {
      return;
    }

    const { height } = centerPopup(
      this.changes,
      POPUP_SIZES.large,
      this.changesOverlay.width || this.renderer.width,
      this.changesOverlay.height || Math.max(1, this.renderer.height - 1),
    );
    this.changesSearch.fit(height - 1);
    this.changesLayout.resize(this.renderer.width >= 100, this.compactPreview);
    const wide = this.renderer.width >= 100;
    this.body.flexDirection = wide ? "row" : "column";
    this.sidebar.width = wide ? "35%" : "100%";
    this.sidebar.height = wide ? "100%" : "50%";
  };

  private loadComparison(): void {
    const cache = this.cache;
    const file = this.selectedFile;
    if (!cache?.state.diff || !file) {
      return;
    }

    cache.comparison = undefined;
    cache.diffError = undefined;
    this.diffRequest?.abort();

    const request = this.request();
    const generation = this.generation;

    this.diffRequest = request;
    this.persist();
    this.render();
    this.launch(async () => {
      try {
        const result = await cache.source.compare(file, request.signal);
        if (!this.current(cache, generation, request) || cache.state.file !== fileKey(file)) {
          return;
        }
        if (!result.ok) {
          cache.diffError = `[${result.error.code}] ${result.error.message}`;
          this.failure(result.error);
        } else {
          cache.comparison = result.value;
        }

        this.pendingRestore = true;
        this.render();
      } finally {
        this.finished(request);
      }
    });
  }

  private back(): void {
    if (!this.cache) {
      return;
    }

    this.remember();
    if (!this.modal && within(this.renderer.currentFocusedRenderable, this.sidebar)) {
      this.history.root.focus();

      return;
    }
    if (this.browser.visible) {
      this.closeBrowser();

      return;
    }
    if (this.cache.state.diff) {
      this.cache.state.diff = false;
      this.diffRequest?.abort();
      this.changesSpinner.cancel();
      this.restoreExternal();
    } else if (this.cache.state.reference !== null) {
      this.filter(null);
      this.render();
      this.history.root.focus();

      return;
    }

    this.persist();
    this.pendingRestore = true;
    this.render();
    const owner = this.changesOwner;
    this.changesOwner = undefined;
    if (owner && !owner.isDestroyed && within(owner, this.body)) {
      owner.focus();
    } else {
      this.history.root.focus();
    }
  }

  private render(): void {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const cache = this.cache;
    const data = cache?.data;
    const state = cache?.state;
    const status = !this.actions
      ? "Git preview · open a real repository to load Git data."
      : (cache?.error ??
        (!data
          ? ""
          : state?.limit === 3000 && data.commits.length === 3000
            ? "Showing 3,000 commits · narrow the ref filter to browse more history."
            : ""));

    this.status.content = status;
    this.status.visible = Boolean(status);
    this.body.visible = !!cache;
    if (!cache || !state) {
      this.changes.visible = false;
      this.changesOverlay.visible = false;
      this.changesSpinner.cancel();

      return;
    }

    this.toolbar.visible = state.reference !== null;
    this.filterText.content = state.reference
      ? `Ref: ${display(state.reference.replace(/^refs\/(heads|remotes|tags)\//, ""))}`
      : "";
    this.changes.visible = this.changesOverlay.visible = state.diff;
    this.diffFocus.visible = this.changes.visible;
    if (!this.changes.visible) {
      this.changesSpinner.cancel();
    }

    this.resizeChanges();
    this.resizeAsk();

    let history: GitListItem[] = [];
    if (data) {
      const commits: GraphCommit[] = [...data.commits];
      if (!state.reference || state.reference === `refs/heads/${data.head}`) {
        commits.unshift({
          oid: workingKey,
          parents: data.headOid ? [data.headOid] : [],
          subject: `Working tree (${data.files.length})`,
          author: "",
          date: "",
          workingTree: true,
        });
      }

      history = layoutGraph(commits, this.historyColumns.graph).map((row): GitListItem => {
        const head = row.commit.oid === data.headOid;
        const labels = data.refs
          .filter(
            (ref) => ref.oid === row.commit.oid && !(head && ref.ref === `refs/heads/${data.head}`),
          )
          .map((ref) => display(`${ref.kind === "tag" ? icons.tag : icons.branch} ${ref.name}`));
        if (head) {
          labels.unshift(
            data.head ? `HEAD → ${icons.branch} ${display(data.head)}` : "HEAD (detached)",
          );
        }

        const subject = display(row.commit.subject);

        return {
          key: row.commit.oid,
          label: row.commit.workingTree
            ? subject
            : [{ text: `${row.commit.oid.slice(0, 7)} `, color: row.color }, { text: subject }],
          graph: row.node,
          connector: row.connector,
          history: { refs: labels, color: row.color, nodeColumn: row.nodeColumn },
        };
      });
    }

    this.history.update(
      history.length
        ? history
        : [{ key: "empty", label: data ? "No commits" : "Loading…", disabled: true }],
      state.selected ?? workingKey,
    );

    const selected = data?.commits.find((commit) => commit.oid === state.selected);
    this.detailText.content = cache.details
      ? describeCommit(cache.details, data?.refs ?? [], data)
      : selected
        ? describeCommit(
            {
              commit: selected,
              message: `${selected.subject}\n\n${cache.error ?? "Loading commit details…"}`,
            },
            data?.refs ?? [],
            data,
          )
        : `Working tree\n\n${data?.head ? `Branch: ${display(data.head)}` : "HEAD (detached)"}`;
    this.updateHistoryRail();

    const files = this.selectedFiles;
    const waiting = Boolean(state.selected && !cache.details && !cache.error);
    const matches = createTextMatcher(this.changes.visible ? this.changesSearch.value : "");
    const filtered = files.filter((file) => matches(`${file.path} ${file.originalPath ?? ""}`));
    if (!waiting && !filtered.some((file) => fileKey(file) === state.file)) {
      state.file = filtered[0] ? fileKey(filtered[0]) : null;
      state.diffScroll = 0;
      cache.comparison = undefined;
      cache.diffError = undefined;
      this.diffRequest?.abort();
    }
    this.filesTitle.content = `Changed files (${files.length})`;
    this.changesSearch.setCounts(
      data && !waiting && !cache.error ? { matched: filtered.length, total: files.length } : null,
    );

    const rowsFor = (candidates: GitFile[]): GitListItem[] => {
      const fileRows: GitListItem[] = [];
      for (const kind of ["commit", "staged", "unstaged", "untracked"] as const) {
        const group = candidates.filter((file) => file.kind === kind);
        if (group.length && kind !== "commit") {
          fileRows.push({
            key: `heading:${kind}`,
            label: kind.toUpperCase(),
            disabled: true,
            gapBefore: fileRows.length > 0,
          });
        }
        for (const file of group) {
          fileRows.push({
            key: fileKey(file),
            label:
              file.status === "M"
                ? [{ text: "M", color: "git.modified" }, { text: display(` ${file.path}`) }]
                : display(`${file.status} ${file.path}`),
            color:
              file.status === "D"
                ? "git.removed"
                : file.status === "A" || file.status === "?"
                  ? "git.added"
                  : "ui.label",
          });
        }
      }

      return fileRows;
    };
    this.files.update(rowsFor(filtered), state.file);
    this.summaryFiles.update(rowsFor(files), state.file);
    this.summaryFilesBody.showEmpty(
      cache.error
        ? "Could not load changed files"
        : !waiting && !files.length
          ? "No changed files"
          : undefined,
      cache.error,
    );
    this.filesBody.showEmpty(
      cache.error
        ? "Could not load changed files"
        : !waiting && !filtered.length
          ? files.length
            ? "No matching files"
            : "No changed files"
          : undefined,
      cache.error,
    );
    this.renderDiff();
    this.applyScroll();
    this.persist();
    this.changed();
  }

  private renderDiff(): void {
    const cache = this.cache;
    if (!cache || !this.changes.visible) {
      return;
    }

    const comparison = cache.comparison;
    if (comparison && comparison === this.renderedComparison && this.diff) {
      return;
    }

    this.diff?.destroyRecursively();
    this.diff = undefined;
    this.renderedComparison = undefined;
    this.diffNotice.visible = true;
    this.comparisonBody.showEmpty();
    this.beforeTitle.content = comparison
      ? `Before · ${display(comparison.beforeLabel)}`
      : "Before";
    this.afterTitle.content = comparison ? `After · ${display(comparison.afterLabel)}` : "After";
    if (!comparison) {
      const empty =
        !cache.diffError &&
        !cache.error &&
        !(cache.state.selected && !cache.details) &&
        !this.selectedFile;
      this.comparisonBody.showEmpty(
        empty
          ? this.changesSearch.value && this.selectedFiles.length
            ? "No matching files"
            : "No changed files"
          : undefined,
      );
      this.diffNotice.visible = !empty && !!(cache.diffError || cache.error);
      this.diffNotice.content = cache.diffError ?? cache.error ?? "";

      return;
    }

    const patch = fullFilePatch(comparison);
    if (!patch.ok) {
      this.diffNotice.content = patch.error.message;

      return;
    }
    if (!patch.value) {
      this.comparisonBody.showEmpty("Both file versions are empty (no text lines).");
      this.diffNotice.visible = false;

      return;
    }

    const styles = uiTheme(this.renderer).styles;
    this.syntax ??= SyntaxStyle.fromStyles(codeStyles(styles), this.renderer.nativeScene!);

    const extension = this.selectedFile?.path.split(".").at(-1)?.toLowerCase();
    let language: string | undefined;
    switch (extension) {
      case "ts":
        language = "typescript";
        break;
      case "tsx":
        language = "typescriptreact";
        break;
      case "js":
      case "jsx":
        language = "javascript";
        break;
      case "md":
        language = "markdown";
        break;
      case "zig":
        language = "zig";
        break;
    }

    this.diff = new DiffRenderable(this.renderer, {
      id: "git-file-diff",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      diff: patch.value,
      view: "split",
      syncScroll: true,
      wrapMode: "none",
      showLineNumbers: true,
      syntaxStyle: this.syntax,
      fg: styles["syntax.text"].fg,
      contextBg: styleBackground(styles["ui.text"]),
      contextContentBg: styleBackground(styles["ui.text"]),
      lineNumberFg: styles["diff.lineNumber"].fg,
      lineNumberBg: styleBackground(styles["diff.lineNumber"]),
      addedBg: styleBackground(styles["diff.added"]),
      addedContentBg: styleBackground(styles["diff.added"]),
      addedLineNumberBg: styleBackground(styles["diff.added"]),
      addedSignColor: styles["diff.added"].fg,
      removedBg: styleBackground(styles["diff.removed"]),
      removedContentBg: styleBackground(styles["diff.removed"]),
      removedLineNumberBg: styleBackground(styles["diff.removed"]),
      removedSignColor: styles["diff.removed"].fg,
      selectionBg: styleBackground(styles["ui.selection"]),
      selectionFg: styles["ui.selection"].fg,
      ...(language ? { filetype: language } : {}),
      ...(this.actions?.treeSitterClient
        ? { treeSitterClient: this.actions.treeSitterClient }
        : {}),
    });
    this.diffBody.add(this.diff);
    this.diffNotice.visible = false;
    this.renderedComparison = comparison;
  }

  private codePanes(): CodeRenderable[] {
    const walk = (node: Renderable): CodeRenderable[] =>
      node instanceof CodeRenderable ? [node] : node.getChildren().flatMap(walk);

    return this.diff ? walk(this.diff).sort((a, b) => a.x - b.x) : [];
  }

  private persist(): void {
    const cache = this.cache;
    if (!this.worktree || !cache) {
      return;
    }

    const state = structuredClone(cache.state);
    if (cache.external) {
      state.diff = false;
      state.file = cache.external.file;
      state.diffScroll = cache.external.diffScroll;
    }

    this.saved(this.worktree.id, state);
  }

  private remember = (): void => {
    if (
      this.restoring ||
      this.pendingRestore ||
      !this.root.visible ||
      !this.cache ||
      this.root.isDestroyed
    ) {
      return;
    }

    const state = this.cache.state;
    if (!this.modal) {
      state.historyScroll = Math.max(0, Math.round(this.history.root.scrollTop));
    }

    if (this.changes.visible) {
      state.filesScroll = Math.max(0, Math.round(this.files.root.scrollTop));
    }
    if (this.browser.visible && this.browser.mode === "refs") {
      state.refsScroll = Math.max(0, Math.round(this.browser.list.root.scrollTop));
    }

    state.detailsScroll = Math.max(0, Math.round(this.details.scrollTop));
    if (this.diff) {
      state.diffScroll = this.codePanes()[0]?.scrollY ?? 0;
    }

    this.persist();
  };

  private canRestore(): boolean {
    const cache = this.cache;

    return (
      this.pendingRestore &&
      this.root.visible &&
      !this.root.isDestroyed &&
      !!cache?.data &&
      (!cache.state.selected || !!cache.details || !!cache.error)
    );
  }

  private applyScroll = (): void => {
    if (!this.canRestore()) {
      return;
    }

    this.restoring = true;
    try {
      const state = this.cache!.state;
      // Prime unchanged geometry immediately and reapply after native resize
      // callbacks update each scroll range. Never restore against placeholders.
      this.history.root.scrollTo(state.historyScroll);
      this.files.root.scrollTo(state.filesScroll);
      this.details.scrollTo(state.detailsScroll);
      for (const code of this.codePanes()) {
        code.scrollY = state.diffScroll;
      }
    } finally {
      this.restoring = false;
    }
  };

  private beforeRender = (): void => {
    this.restoreScroll();
  };

  private restoreScroll = (): void => {
    if (!this.canRestore()) {
      return;
    }

    // Native code-pane viewports are measured now; their scroll offset changes
    // drawing, unlike ScrollBox translations which were settled during layout.
    this.applyScroll();
    this.pendingRestore = false;
  };

  command(command: CommandId): void {
    const focus = this.renderer.currentFocusedRenderable;
    const list =
      this.changes.visible && focus === this.changesSearch
        ? this.files
        : [this.history, this.files, this.summaryFiles].find((item) => within(focus, item.root));
    if (
      this.browser.visible &&
      !this.dialog.visible &&
      command !== "git.ask" &&
      command !== "git.copy"
    ) {
      if (command === "git.refresh") {
        this.refresh();
      } else {
        this.browser.command(command);
      }

      return;
    }
    if (this.changes.visible && !this.dialog.visible) {
      if (command === "git.search") {
        this.changesSearch.focus();
        return;
      }
      if (command === "git.search-clear") {
        this.changesSearch.clear();
        return;
      }
      if (command === "git.preview") {
        if (focus === this.diffFocus) {
          this.compactPreview = false;
          this.resizeChanges();
          this.changesSearch.focus();
        } else {
          this.focusPreview();
        }
        return;
      }
      if (command === "git.open" && (list === this.files || focus === this.changesSearch)) {
        if (this.selectedFile) this.focusPreview();
        return;
      }
      if (
        focus === this.changesSearch &&
        (command === "git.half-page-up" || command === "git.half-page-down")
      ) {
        this.compactPreview = false;
        this.resizeChanges();
        this.files.root.focus();
      }
    }
    switch (command) {
      case "git.refs":
        this.openBrowser("refs");
        return;
      case "git.reflog":
        this.openBrowser("reflog");
        return;
      case "git.ask":
        this.openAsk();
        return;
      case "git.copy": {
        const context = this.context;
        if (context) {
          this.copy(context.copy);
        }

        return;
      }
      case "git.submit":
        this.launch(() => this.submit());
        return;
      case "git.change-session":
        this.cycleSession();
        return;
      case "git.newline":
        this.prompt.newLine();
        return;
      case "git.clear":
        this.prompt.clear();
        return;
      case "git.paste":
        this.launch(() => this.prompt.pasteClipboard());
        return;
      case "git.inspect":
        this.prompt.inspectAtCursor();
        return;
      case "git.cancel":
        this.closeAsk();
        return;
      case "git.refresh":
        this.refresh();
        return;
      case "git.more":
        this.more();
        return;
      case "git.back":
        if (this.dialog.visible) {
          this.closeAsk();
        } else if (this.canGoBack) {
          this.back();
        }
        return;
      case "git.tab-previous":
      case "git.tab-next":
        return;
      case "git.open":
        list?.open();
        return;
      case "git.previous":
      case "git.next":
      case "git.first":
      case "git.last":
        if (list) {
          list.move(command.slice(4) as "previous" | "next" | "first" | "last");

          return;
        }
        break;
      case "git.half-page-up":
      case "git.half-page-down":
        if (list) {
          list.moveHalfPage(command === "git.half-page-up" ? -1 : 1);

          return;
        }
        break;
    }

    const half = command === "git.half-page-up" || command === "git.half-page-down";
    const down =
      command === "git.next" || command === "git.page-down" || command === "git.half-page-down";
    const page = command === "git.page-down" || command === "git.page-up";
    const height = within(focus, this.diffFocus)
      ? (this.codePanes()[0]?.height ?? this.diffFocus.height)
      : focus === this.details
        ? this.details.viewport.height
        : this.history.root.viewport.height;
    const delta =
      (down ? 1 : -1) *
      (half ? halfPageStep(height) : page ? Math.max(1, this.main.height - 3) : 1);
    if (within(focus, this.diffFocus)) {
      const panes = this.codePanes();
      const left = panes[0];
      if (left) {
        const x = Math.max(0, left.scrollX + (command === "git.right" ? 4 : -4));
        const y =
          command === "git.first"
            ? 0
            : command === "git.last"
              ? left.maxScrollY
              : Math.max(0, Math.min(left.maxScrollY, left.scrollY + delta));
        for (const pane of panes) {
          if (command === "git.left" || command === "git.right") {
            pane.scrollX = x;
          } else {
            pane.scrollY = y;
          }
        }
      }
    } else if (focus === this.details) {
      if (command === "git.first") {
        this.details.scrollTo(0);
      } else if (command === "git.last") {
        this.details.scrollTo(Infinity);
      } else {
        this.details.scrollBy(delta);
      }
    } else if (list && page) {
      list.root.scrollBy(delta);
    }

    this.remember();
  }

  available(command: CommandId): boolean {
    if (command === "git.tab-previous" || command === "git.tab-next") {
      return false;
    }
    if (command === "git.refs" || command === "git.reflog") {
      return this.root.visible && !!this.cache && !this.modal;
    }
    if (command === "git.search" || command === "git.search-clear") {
      return (this.browser.visible || this.changes.visible) && !this.dialog.visible;
    }
    if (command === "git.preview") {
      return (
        (this.changes.visible || (this.browser.visible && this.browser.mode === "reflog")) &&
        !this.dialog.visible
      );
    }
    if (command === "git.open" && this.changes.visible && !this.dialog.visible) {
      return !!this.selectedFile && !within(this.renderer.currentFocusedRenderable, this.diffFocus);
    }
    if (command === "git.open" && this.browser.visible && !this.dialog.visible) {
      return this.browser.canOpen;
    }
    if (command === "git.more") {
      return this.root.visible && this.canLoadMore;
    }
    if (command === "git.back") {
      return (
        this.root.visible &&
        within(this.renderer.currentFocusedRenderable, this.root) &&
        this.canGoBack
      );
    }
    if (command === "git.left" || command === "git.right") {
      return within(this.renderer.currentFocusedRenderable, this.diffFocus);
    }
    if (command === "git.ask" || command === "git.copy") {
      return !!this.context;
    }
    if (command === "git.submit") {
      return !!this.ask && !this.ask.sending && !this.prompt.pending && !!this.prompt.value.trim();
    }
    if (command === "git.change-session") {
      return !!this.ask && !this.ask.sending;
    }
    if (command === "git.newline" || command === "git.paste" || command === "git.clear") {
      return !!this.ask;
    }
    if (command === "git.inspect") {
      return !!this.ask && !!this.inspect && this.prompt.canInspect;
    }
    if (command === "git.cancel") {
      return !!this.ask;
    }

    return !!this.cache;
  }

  private openAsk(): void {
    const context = this.context;
    if (!context || !this.worktree || !this.actions) {
      return;
    }

    this.ask = {
      context: structuredClone(context),
      worktree: this.worktree,
      session: this.worktree.sessions.some((session) => session.id === this.sessionId)
        ? this.sessionId
        : null,
      owner: this.renderer.currentFocusedRenderable,
      sending: false,
    };
    this.prompt.setWorkingDirectory(this.worktree.path);
    this.prompt.value = "";
    this.prompt.placeholder = `Ask about ${context.label}`;
    this.dialog.visible = this.dialogOverlay.visible = true;
    this.resizeAsk();
    this.prompt.focus();
    this.changed();
  }

  private cycleSession(): void {
    if (!this.ask || this.ask.sending) {
      return;
    }

    const choices = [...(this.worktree?.sessions ?? []).map((session) => session.id), null];
    this.ask.session = choices[(choices.indexOf(this.ask.session) + 1) % choices.length]!;
    this.changed();
  }

  private closeAsk(restoreFocus = true): void {
    const ask = this.ask;
    this.ask = undefined;
    this.dialog.visible = this.dialogOverlay.visible = false;
    this.prompt.cancelPaste();
    if (restoreFocus && ask?.owner && !ask.owner.isDestroyed) {
      ask.owner.focus();
    }

    this.changed();
  }

  private async submit(): Promise<void> {
    const ask = this.ask;
    const actions = this.actions;
    if (!ask || !actions || ask.sending || this.prompt.pending || !this.prompt.value.trim()) {
      return;
    }

    const fingerprint = () => {
      const draft = this.prompt.draft;

      return JSON.stringify([draft.value, draft.tokens]);
    };
    const input = fingerprint();
    const submission = this.prompt.submission;
    const text = gitPrompt(submission.text, ask.context);

    ask.sending = true;
    try {
      if (!ask.session) {
        const created = await actions.createSession(ask.worktree.id);
        if (!created.ok) {
          this.failure(created.error);

          return;
        }

        ask.session = created.value;
        ask.createdSession = created.value;
      } else if (
        ask.session !== ask.createdSession &&
        !(this.worktree?.id === ask.worktree.id ? this.worktree : ask.worktree).sessions.some(
          (session) => session.id === ask.session,
        )
      ) {
        this.failure(new InputError("The selected session is not in this worktree."));

        return;
      }

      const result = submission.images.length
        ? await actions.prompt(ask.session, text, submission.images)
        : await actions.prompt(ask.session, text);
      if (!result.ok) {
        this.failure(result.error);

        return;
      }
      if (this.ask === ask && !this.disposed) {
        if (fingerprint() === input) {
          this.closeAsk();
        } else {
          this.notice("Request accepted · newer input retained");
        }
      }
    } finally {
      ask.sending = false;
      if (this.ask === ask && !this.disposed) {
        this.changed();
      }
    }
  }

  private keepFocus = (focused: Renderable | null): void => {
    if (!this.root.visible || this.root.isDestroyed || this.renderer.isDestroyed || this.disposed) {
      return;
    }
    // Compact panes can blur before focusing their replacement; null is not an exit.
    if (focused) {
      const entered = within(focused, this.root);
      const returned = entered && !this.focused;

      this.focused = entered;
      if (returned) {
        this.refreshOnFocus();
      }
    }

    this.updateHistoryRail();
    if (!this.modal) {
      return;
    }
    // App-wide search and inspectors own their focus; only guard background Git controls.
    if (!within(focused, this.root)) {
      return;
    }
    if (this.dialog.visible) {
      if (!within(focused, this.dialog)) {
        this.prompt.focus();
      }

      return;
    }

    const popup = this.changes.visible ? this.changes : this.browser.root;
    if (!within(focused, popup)) {
      this.focus();
    }
  };

  private resizeAsk = (): void => {
    if (this.disposed || !this.dialog?.visible || this.prompt.isDestroyed) {
      return;
    }

    const width = this.dialogOverlay.width || this.root.width;
    const height = this.dialogOverlay.height || this.root.height;
    const maximum = getPopupSize(POPUP_SIZES.compact, width, height);
    const input = this.prompt.fit(maximum.height);
    centerPopup(this.dialog, { ...POPUP_SIZES.compact, height: input.height }, width, height);
  };

  private copy(text: string): void {
    this.launch(async () => {
      const result = await (this.actions?.copy
        ? this.actions.copy(text)
        : this.clipboard.copy(text));
      if (result.ok) {
        this.notice(result.value, { level: "success", source: "Git" });
      } else {
        this.failure(result.error);
      }
    });
  }

  private selectionFinished = (selection: Selection): void => {
    const pointer = this.pointer;
    this.pointer = undefined;
    if (!pointer?.moved || !this.root.visible || this.dialog.visible || !this.actions) {
      return;
    }
    if (
      selection.anchor.x < this.root.x ||
      selection.anchor.x >= this.root.x + this.root.width ||
      selection.anchor.y < this.root.y ||
      selection.anchor.y >= this.root.y + this.root.height
    ) {
      return;
    }

    const panes = this.changes.visible ? this.codePanes() : [];
    const pane = panes.find(
      (code) =>
        selection.anchor.x >= code.x &&
        selection.anchor.x < code.x + code.width &&
        selection.anchor.y >= code.y &&
        selection.anchor.y < code.y + code.height,
    );
    if (pane) {
      // Clamp the final range to its starting code pane before extracting text.
      this.renderer.updateSelection(
        pane,
        Math.max(pane.x, Math.min(pane.x + pane.width - 1, selection.focus.x)),
        Math.max(pane.y, Math.min(pane.y + pane.height - 1, selection.focus.y)),
        { finishDragging: true },
      );
    }
    if (!pane) {
      const regions = this.changes.visible
        ? [this.files.root.viewport]
        : this.browser.visible
          ? this.browser.selectionRegion
          : [this.details.viewport, this.summaryFiles.root.viewport, this.history.root.viewport];
      const region = regions
        .map((target) => ({
          target,
          left: target.x,
          right: target.x + target.width - 1,
          top: target.y,
          bottom: target.y + target.height - 1,
        }))
        .find(
          (view) =>
            selection.anchor.x >= view.left &&
            selection.anchor.x <= view.right &&
            selection.anchor.y >= view.top &&
            selection.anchor.y <= view.bottom,
        );
      if (region) {
        this.renderer.updateSelection(
          region.target,
          Math.max(region.left, Math.min(region.right, selection.focus.x)),
          Math.max(region.top, Math.min(region.bottom, selection.focus.y)),
          { finishDragging: true },
        );
      }
    }

    const text = pane ? pane.getSelectedText() : selection.getSelectedText();
    if (text) {
      this.copy(text);
    }
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.hide();
    this.disposed = true;
    this.renderer.off("selection", this.selectionFinished);
    this.renderer.off("focused_renderable", this.keepFocus);
    this.renderer.off("focus", this.refreshOnFocus);
    this.prompt.off(InputRenderableEvents.INPUT, this.resizeAsk);
    this.prompt.off("resize", this.resizeAsk);
    this.prompt.off("line-info-change", this.resizeAsk);
    this.prompt.dispose();
    this.browser.dispose();
    this.changesSearch.off(InputRenderableEvents.INPUT, this.filterChanges);
    this.files.root.viewport.off("resize", this.revealFile);
    for (const box of [this.history.root, this.files.root, this.details]) {
      box.content.off("resize", this.applyScroll);
      box.viewport.off("resize", this.applyScroll);
    }

    void this.clipboard
      .dispose()
      .catch((error: unknown) => reportUnexpected(error, "Git clipboard cleanup"));
    this.root.destroyRecursively();
    this.syntax?.destroy();
  }
}
