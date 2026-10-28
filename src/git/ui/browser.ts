import {
  BoxRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { CommandId, KeyContext } from "../../keybindings/commands.ts";
import { footerKeyHint } from "../../keybindings/footer.ts";
import type { FooterShortcut } from "../../ui/footer.ts";
import { SearchInput } from "../../ui/search-input.ts";
import { createTextMatcher } from "../../search.ts";
import { halfPageStep } from "../../ui/navigation.ts";
import { LoadingSpinner } from "../../ui/loading-spinner.ts";
import { uiTheme } from "../../ui/theme.ts";
import { PopupFrame } from "../../ui/popup-frame.ts";
import {
  POPUP_SIZES,
  PopupBody,
  SearchPopupLayout,
  attachPopupActivity,
  centerPopup,
} from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { icons } from "../../icons.ts";
import { describeCommit, refContext, reflogContext, type GitContext } from "../context.ts";
import type { GitDetails, GitReflog, GitSnapshot } from "../model.ts";
import { GitList, type GitListItem } from "./list.ts";

export type GitBrowserKind = "refs" | "reflog";
const allRefs = "__all_refs__";
const display = (value: string) =>
  value.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Render control characters as visible escapes, never terminal commands.
    /[\x00-\x1f\x7f-\x9f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
type Actions = {
  changed(): void;
  close(): void;
  selected(kind: GitBrowserKind, key: string | null): void;
  filter(ref: string | null): void;
  open(details: GitDetails): void;
  inspect(event: GitReflog, signal: AbortSignal): Promise<Result<GitDetails, ExpectedError>>;
  hint(command: CommandId, context: KeyContext): string;
};

// Refs and reflog share query/cursor ownership, never the canonical commit selection.
export class GitBrowser {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: GitList;
  readonly preview: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly body: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly previewBody: PopupBody;
  private readonly message: TextRenderable;
  private readonly previewPane: BoxRenderable;
  private readonly previewText: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private snapshot: GitSnapshot | undefined;
  private loadError: string | undefined;
  private summary = "";
  private kind: GitBrowserKind = "refs";
  private key: string | null = null;
  private compactPreview = false;
  private previewSelector: string | undefined;
  private requestedOid: string | undefined;
  private request: AbortController | undefined;
  private openAfterLoad: string | undefined;
  private revision = 0;
  private disposed = false;
  private readonly results = new Map<string, Result<GitDetails, ExpectedError>>();
  private readonly unexpected = new Map<string, string>();

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: Actions,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "git-browser",
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      zIndex: 50,
      visible: false,
      onSizeChange: () => this.resize(),
    });
    this.panel = new PopupFrame(renderer, {
      id: "git-browser-panel",
      position: "absolute",
      border: false,
      paddingX: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
    });
    this.spinner = new LoadingSpinner(renderer, { id: "git-browser-loading" });
    this.search = new SearchInput(renderer, { id: "git-browser-search", title: "Refs" });
    this.message = new TextRenderable(renderer, {
      id: "git-browser-status",
      height: 1,
      flexShrink: 0,
      selectable: false,
      wrapMode: "none",
      truncate: true,
    });
    this.list = new GitList(
      renderer,
      "git-browser-list",
      (key) => this.choose(key),
      () => this.open(),
      false,
      "ui.popup",
    );
    this.list.root.width = "100%";
    this.preview = new ScrollBoxRenderable(renderer, {
      id: "git-reflog-preview",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      scrollX: false,
      onMouseDown: () => this.preview.focus(),
    });
    this.previewText = new TextRenderable(renderer, {
      id: "git-reflog-preview-text",
      width: "100%",
      wrapMode: "word",
      selectable: true,
    });
    this.preview.add(this.previewText);
    this.previewBody = new PopupBody(renderer, "git-reflog-preview-pane", this.preview);
    this.previewPane = this.previewBody.root;
    this.layout = new SearchPopupLayout(renderer, {
      id: "git-browser",
      search: this.search,
      message: this.message,
      list: this.list.root,
      preview: { body: this.previewBody, width: 48 },
    });
    this.body = this.layout.root;
    this.panel.add(this.body);
    attachPopupActivity(renderer, this.layout.results.root, this.spinner.root, () => ({
      pending: (!this.snapshot && !this.loadError) || this.request !== undefined,
      hasContent: this.snapshot !== undefined || this.loadError !== undefined,
      message: "Loading Git data…",
      anchor:
        this.request && this.key
          ? this.list.root.findDescendantById(`${this.list.root.id}:${this.key}`)
          : undefined,
    }));
    this.root.add(this.panel);
    const theme = uiTheme(renderer);
    theme.scrollbars(this.preview);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg;
      this.previewPane.borderColor = styles["ui.border"].fg;
      paintText(this.message, styles["ui.muted"]);
      paintText(this.spinner.root, styles["status.working"]);
      paintText(this.previewText, styles["ui.label"]);
      this.previewText.selectionBg = styles["ui.selection"].bg;
      this.previewText.selectionFg = styles["ui.selection"].fg;
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize);
  }
  get visible(): boolean {
    return !this.disposed && !this.root.isDestroyed && this.root.visible;
  }
  get mode(): GitBrowserKind {
    return this.kind;
  }
  get context(): KeyContext {
    return this.search.focused ? "git-search" : "git";
  }
  get focusTargets(): Renderable[] {
    return [
      this.search,
      ...(this.list.root.visible ? [this.list.root] : []),
      ...(this.previewPane.visible ? [this.preview] : []),
    ];
  }
  get selectionContext(): GitContext | null {
    if (!this.list.root.focused) return null;
    if (this.kind === "reflog") {
      const event = this.event;
      return event ? reflogContext(event) : null;
    }
    const ref = this.snapshot?.refs.find((ref) => ref.ref === this.key);
    return ref ? refContext(ref) : null;
  }
  get selection(): string | null {
    return this.key === allRefs ? null : this.key;
  }
  get canOpen(): boolean {
    if (!this.snapshot || this.loadError || !this.key) return false;
    if (this.kind === "refs") return true;
    const event = this.event;
    if (!event) return false;
    const result = this.results.get(event.oid);
    return result ? result.ok : !this.unexpected.has(event.oid) && this.requestedOid === event.oid;
  }
  get selectionRegion(): Renderable[] {
    return [this.list.root.viewport, ...(this.previewPane.visible ? [this.preview.viewport] : [])];
  }
  get shortcuts(): FooterShortcut[] {
    const hint = (command: CommandId, label: string) => ({
      key: footerKeyHint(command, this.context, this.actions.hint(command, this.context)),
      label,
    });
    const target = this.selectionContext;
    return [
      ...(this.canOpen ? [hint("git.open", this.kind === "refs" ? "Filter" : "Open commit")] : []),
      hint("git.back", "Close"),
      ...(target
        ? [
            hint("git.ask", this.kind === "refs" ? "Ask ref" : "Ask event"),
            hint("git.copy", this.kind === "refs" ? "Copy name" : "Copy hash"),
          ]
        : []),
      hint("git.previous", "Previous"),
      hint("git.next", "Next"),
      hint("git.half-page-down", "½ page"),
      ...(this.kind === "reflog" ? [hint("git.preview", "Preview")] : []),
      hint("focus.next", "Pane"),
      ...(this.search.focused && this.search.value ? [hint("git.search-clear", "Clear")] : []),
    ];
  }
  show(kind: GitBrowserKind, snapshot: GitSnapshot | undefined, selected: string | null): void {
    this.cancel();
    this.results.clear();
    this.unexpected.clear();
    this.snapshot = snapshot;
    this.loadError = undefined;
    this.kind = kind;
    this.key = kind === "refs" ? (selected ?? allRefs) : selected;
    this.compactPreview = false;
    this.previewSelector = undefined;
    this.root.visible = true;
    this.search.setTitle(kind === "refs" ? "Refs" : "Reflog");
    this.search.value = "";
    this.filter();
    this.resize();
    this.search.focus();
    if (!snapshot) this.spinner.start();
    this.actions.changed();
  }
  update(snapshot: GitSnapshot | undefined, error?: string): void {
    this.cancel();
    this.results.clear();
    this.unexpected.clear();
    this.snapshot = snapshot;
    this.loadError = error;
    this.previewSelector = undefined;
    if (this.visible) this.filter();
  }
  hide(): void {
    this.cancel();
    this.spinner.cancel();
    this.openAfterLoad = undefined;
    if (!this.root.isDestroyed && !this.renderer.isDestroyed) {
      this.root.visible = false;
      this.actions.changed();
    }
  }
  private get event(): GitReflog | undefined {
    return this.snapshot?.reflog.find((event) => event.selector === this.key);
  }
  private cancel(): void {
    this.revision++;
    this.request?.abort();
    this.request = undefined;
    this.requestedOid = undefined;
    this.openAfterLoad = undefined;
    this.spinner.stop();
  }
  private filter = (): void => {
    if (!this.visible) return;
    this.openAfterLoad = undefined;
    const matches = createTextMatcher(this.search.value),
      rows: GitListItem[] = [];
    if (this.kind === "refs") {
      if (matches("All refs")) rows.push({ key: allRefs, label: "All refs" });
      for (const [kind, label] of [
        ["local", "Local"],
        ["remote", "Remote"],
        ["tag", "Tags"],
      ] as const) {
        const refs =
          this.snapshot?.refs.filter((ref) => ref.kind === kind && matches(ref.name)) ?? [];
        if (refs.length)
          rows.push({ key: `heading:${kind}`, label, disabled: true, gapBefore: rows.length > 0 });
        for (const ref of refs)
          rows.push({
            key: ref.ref,
            label: display(`${ref.kind === "tag" ? icons.tag : icons.branch} ${ref.name}`),
            color:
              ref.kind === "local" && ref.name === this.snapshot?.head
                ? "git.currentRef"
                : "ui.label",
          });
      }
    } else {
      for (const event of this.snapshot?.reflog ?? []) {
        if (matches(`${event.selector} ${event.oid} ${event.subject} ${event.date}`))
          rows.push({
            key: event.selector,
            label: [
              { text: display(`${event.date.slice(0, 16)}  ${event.selector}  `) },
              { text: event.oid.slice(0, 7), color: "git.hash" },
              { text: display(`  ${event.subject}`) },
            ],
          });
      }
    }
    const candidates = rows.filter((row) => !row.disabled);
    this.search.setCounts(
      this.snapshot && !this.loadError
        ? {
            matched: candidates.length,
            total:
              this.kind === "refs" ? this.snapshot.refs.length + 1 : this.snapshot.reflog.length,
          }
        : null,
    );
    if (!candidates.some((row) => row.key === this.key)) this.key = candidates[0]?.key ?? null;
    this.list.update(
      rows.length || (this.snapshot && !this.loadError)
        ? rows
        : this.loadError
          ? [{ key: "empty", label: this.loadError, disabled: true }]
          : [],
      this.key,
    );
    const empty = !!this.snapshot && !this.loadError && !candidates.length;
    this.layout.results.showEmpty(empty ? "No matches" : undefined);
    this.message.visible = !empty && (this.snapshot !== undefined || this.loadError !== undefined);
    const noun = this.kind === "refs" ? "result" : "event";
    this.summary = !this.snapshot
      ? "Loading Git data…"
      : `${candidates.length} ${noun}${candidates.length === 1 ? "" : "s"}`;
    this.message.content = this.loadError ?? this.summary;
    if (this.key) this.list.root.scrollChildIntoView(`git-browser-list:${this.key}`);
    this.actions.selected(this.kind, this.selection);
    this.schedulePreview();
    this.actions.changed();
  };
  private choose(key: string): void {
    this.openAfterLoad = undefined;
    this.key = key;
    this.actions.selected(this.kind, this.selection);
    this.schedulePreview();
    this.actions.changed();
  }
  private schedulePreview(): void {
    if (!this.snapshot && !this.loadError) {
      if (!this.spinner.root.visible) this.spinner.start();
      return;
    }
    if (this.kind !== "reflog") {
      this.spinner.stop();
      return;
    }
    const event = this.event;
    if (event?.selector !== this.previewSelector) {
      this.previewSelector = event?.selector;
      this.preview.scrollTo(0);
      this.openAfterLoad = undefined;
    }
    if (!event || this.loadError) {
      this.cancel();
      this.renderPreview();
      return;
    }
    if (
      this.results.has(event.oid) ||
      this.unexpected.has(event.oid) ||
      this.requestedOid === event.oid
    ) {
      this.renderPreview();
      return;
    }
    this.cancel();
    const revision = this.revision,
      request = new AbortController();
    this.request = request;
    this.requestedOid = event.oid;
    this.spinner.start();
    this.renderPreview();
    void this.actions
      .inspect(event, request.signal)
      .then((result) => {
        if (!this.current(revision, request)) return;
        this.results.set(event.oid, result);
        if (this.results.size > 16) this.results.delete(this.results.keys().next().value!);
        this.renderPreview();
        if (this.openAfterLoad === this.key && result.ok) this.actions.open(result.value);
        this.openAfterLoad = undefined;
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        const message = reportUnexpected(error, "Git reflog preview");
        if (this.current(revision, request)) {
          this.unexpected.set(event.oid, message);
          if (this.unexpected.size > 16)
            this.unexpected.delete(this.unexpected.keys().next().value!);
          this.renderPreview();
        }
      })
      .finally(() => {
        if (this.current(revision, request)) {
          this.request = undefined;
          this.requestedOid = undefined;
          this.spinner.stop();
          this.actions.changed();
        }
      });
  }
  private current(revision: number, request: AbortController): boolean {
    return (
      this.visible &&
      this.revision === revision &&
      !request.signal.aborted &&
      !this.renderer.isDestroyed
    );
  }
  private renderPreview(): void {
    const event = this.event,
      result = event ? this.results.get(event.oid) : undefined;
    const failure =
      result && !result.ok
        ? `[${result.error.code}] ${result.error.message}`
        : event
          ? this.unexpected.get(event.oid)
          : undefined;
    this.message.content = this.loadError ?? failure ?? this.summary;
    this.previewBody.showEmpty(!event ? "Select a reflog event" : undefined);
    this.previewText.content = !event
      ? ""
      : [
          `Event ${display(event.selector)}`,
          `Occurred: ${display(event.date)}`,
          display(event.subject),
          "",
          "Target commit",
          result
            ? result.ok
              ? describeCommit(result.value, this.snapshot?.refs ?? [], this.snapshot)
              : `[${result.error.code}] ${result.error.message}`
            : (this.loadError ?? this.unexpected.get(event.oid) ?? `Commit ${event.oid}`),
        ].join("\n");
    this.actions.changed();
  }
  private open(): void {
    if (!this.snapshot || this.loadError || !this.key) return;
    if (this.kind === "refs") {
      this.actions.filter(this.key === allRefs ? null : this.key);
      return;
    }
    const event = this.event,
      result = event ? this.results.get(event.oid) : undefined;
    if (result?.ok) this.actions.open(result.value);
    else if (event && this.requestedOid === event.oid) this.openAfterLoad = event.selector;
  }
  command(command: CommandId): void {
    if (command === "git.back") {
      this.actions.close();
      return;
    }
    if (command === "git.search-clear") {
      this.search.clear();
      return;
    }
    if (command === "git.search") {
      this.search.focus();
      return;
    }
    if (command === "git.open") {
      this.open();
      return;
    }
    if (command === "git.preview") {
      this.togglePreview();
      return;
    }
    const half = command === "git.half-page-up" || command === "git.half-page-down";
    const down =
      command === "git.next" || command === "git.page-down" || command === "git.half-page-down";
    if (this.preview.focused) {
      if (command === "git.first") this.preview.scrollTo(0);
      else if (command === "git.last") this.preview.scrollTo(Number.MAX_SAFE_INTEGER);
      else
        this.preview.scrollBy(
          (down ? 1 : -1) *
            (half
              ? halfPageStep(this.preview.viewport.height)
              : command === "git.page-up" || command === "git.page-down"
                ? Math.max(1, this.preview.viewport.height - 1)
                : 1),
        );
    } else if (half) {
      const height = this.layout.listHeight;
      if (this.search.focused) {
        this.compactPreview = false;
        this.resize();
        this.list.root.focus();
      }
      this.list.move(down ? "next" : "previous", halfPageStep(height));
    } else if (command === "git.first" || command === "git.last")
      this.list.move(command === "git.first" ? "first" : "last");
    else if (command === "git.previous" || command === "git.next")
      this.list.move(down ? "next" : "previous");
    else if (command === "git.page-up" || command === "git.page-down")
      this.list.move(down ? "next" : "previous", Math.max(1, this.list.root.viewport.height));
    this.actions.changed();
  }
  private togglePreview(): void {
    if (this.kind !== "reflog") return;
    if (this.renderer.width < 100) {
      this.compactPreview = !this.compactPreview;
      this.resize();
      (this.compactPreview ? this.preview : this.search).focus();
    } else if (this.preview.focused) this.search.focus();
    else this.preview.focus();
  }
  moveFocus(direction: 1 | -1): void {
    if (this.renderer.width < 100 && this.kind === "reflog") {
      const targets: Renderable[] = [this.search, this.list.root, this.preview];
      const index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      const next = targets[(index + direction + targets.length) % targets.length]!;
      this.compactPreview = next === this.preview;
      this.resize();
      next.focus();
    } else {
      const targets = this.focusTargets,
        index = targets.indexOf(this.renderer.currentFocusedRenderable!);
      targets[(index + direction + targets.length) % targets.length]?.focus();
    }
    this.actions.changed();
  }
  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed || this.renderer.isDestroyed) return;
    const availableWidth = this.root.width || this.renderer.width,
      availableHeight = this.root.height || this.renderer.height - 1;
    const size = this.kind === "reflog" ? POPUP_SIZES.expanded : POPUP_SIZES.standard;
    const { height } = centerPopup(this.panel, size, availableWidth, availableHeight);
    this.search.fit(Math.max(1, height - 7));
    this.layout.resize(this.renderer.width >= 100, this.compactPreview, this.kind === "reflog");
  };
  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.search.off(InputRenderableEvents.INPUT, this.filter);
    this.renderer.off("resize", this.resize);
    if (!this.root.isDestroyed) this.root.destroyRecursively();
  }
}
