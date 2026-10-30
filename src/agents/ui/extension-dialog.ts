import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionDialog, ExtensionUiResponse } from "../extension-ui.ts";
import { inScope, type CommandId, type KeyContext } from "../../keybindings/commands.ts";
import { keyToken, type Keymap } from "../../keybindings/config.ts";
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
import { InputField } from "../../ui/input-field.ts";
import { TerminalSurface } from "../../ui/embedded-terminal/surface.ts";
import {
  POPUP_SIZES,
  SearchPopupLayout,
  attachPopupActivity,
  centerPopup,
} from "../../ui/popup-layout.ts";
import { paintText } from "../../ui/theme-styles.ts";
import { createTextMatcher } from "../../search.ts";
import { reportUnexpected, type ExpectedError } from "../../errors.ts";
import type { Result } from "../../result.ts";
import type { FooterShortcut } from "../../ui/footer.ts";

type Scope = { sessionId: string; conversationId: string; dialog: ExtensionDialog };

export type ExtensionDialogActions = {
  answer: (
    sessionId: string,
    conversationId: string,
    response: ExtensionUiResponse,
  ) => Promise<Result<void, ExpectedError>>;
  changed: () => void;
  fallback: () => void;
  notice: Notice;
  keyHint: (command: CommandId, context: KeyContext) => string;
};

const plain = (text: string) => {
  // oxlint-disable-next-line eslint/no-control-regex -- Extension text must not inject terminal control bytes.
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
};

export class ExtensionDialogPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  readonly input: InputRenderable;
  readonly editor: TextareaRenderable;
  private readonly editorField: InputField;
  private readonly component: TerminalSurface;
  private componentQueue: Promise<void> = Promise.resolve();
  private readonly panel: BoxRenderable;
  private readonly layout: SearchPopupLayout;
  private readonly details: ScrollBoxRenderable;
  private readonly body: TextRenderable;
  private readonly spinner: LoadingSpinner;
  private readonly clipboard: Clipboard;
  private scope: Scope | undefined;
  private owner: Renderable | undefined;
  private coveredFocus: Renderable | undefined;
  private candidates: { label: string; value: string | boolean }[] = [];
  private filtered: typeof this.candidates = [];
  private rows: { root: BoxRenderable; text: TextRenderable }[] = [];
  private cursor = 0;
  private busy = false;
  private completedId: string | undefined;
  private disposed = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: ExtensionDialogActions,
  ) {
    const theme = uiTheme(renderer);
    this.clipboard = new Clipboard(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "extension-dialog",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 5700,
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => event.stopPropagation(),
    });
    this.panel = new PopupFrame(renderer, {
      id: "extension-dialog-panel",
      position: "absolute",
      border: false,
      paddingX: 0,
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "extension-dialog-loading" });
    this.details = new ScrollBoxRenderable(renderer, {
      id: "extension-dialog-details",
      paddingX: 1,
      flexGrow: 1,
      minHeight: 1,
      minWidth: 0,
      scrollX: false,
      onMouseDown: () => this.details.focus(),
    });
    this.body = new TextRenderable(renderer, {
      id: "extension-dialog-body",
      width: "100%",
      wrapMode: "char",
      selectable: true,
    });
    this.details.add(this.body);
    this.search = new SearchInput(renderer, { id: "extension-dialog-search", title: "Options" });
    this.list = new ScrollBoxRenderable(renderer, {
      id: "extension-dialog-list",
      flexGrow: 1,
      minHeight: 1,
      minWidth: 0,
      scrollX: false,
      onMouseDown: () => this.list.focus(),
    });
    this.input = new InputRenderable(renderer, {
      id: "extension-dialog-input",
      width: "100%",
      maxLength: 65536,
      visible: false,
    });
    this.editor = new TextareaRenderable(renderer, {
      id: "extension-dialog-editor",
      width: "auto",
      height: 8,
      flexGrow: 1,
      keyBindings: [{ name: "return", action: "newline" }],
    });
    this.editorField = new InputField(
      renderer,
      this.editor,
      "search",
      "extension-dialog-editor-field",
      "ui.popup",
    );
    this.editorField.visible = false;
    this.component = new TerminalSurface(renderer, "extension-dialog-component");
    this.component.root.visible = false;
    this.component.root.maxWidth = 200;
    this.component.root.maxHeight = 80;
    this.layout = new SearchPopupLayout(renderer, {
      id: "extension",
      search: this.search,
      list: this.list,
    });
    this.panel.add(this.details);
    this.panel.add(this.layout.root);
    this.panel.add(this.input);
    this.panel.add(this.editorField);
    this.panel.add(this.component.root);
    attachPopupActivity(renderer, this.panel, this.spinner.root, () => ({
      pending: this.busy,
      hasContent: true,
      message: "",
      title: this.search.field.visible ? this.search.field : undefined,
      body: this.editorField.visible
        ? this.editorField
        : this.list.visible
          ? this.layout.results.root
          : this.details,
      anchor: this.list.visible ? this.rows[this.cursor]?.root : undefined,
    }));
    this.root.add(this.panel);
    theme.scrollbars(this.details);
    theme.scrollbars(this.list);
    theme.input(this.input);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg;
      paintText(this.body, styles["ui.label"]);
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize);
    renderer.on("focused_renderable", this.keepFocus);
    this.resize();
  }

  get visible(): boolean {
    return !this.disposed && this.root.visible;
  }

  get context(): KeyContext {
    if (this.scope?.dialog.kind === "custom") return "extension-custom";
    if (this.scope?.dialog.kind === "editor") return "extension-editor";
    if (this.input.focused) {
      return "extension-input";
    }

    if (this.search.focused) {
      return "extension-search";
    }

    if (this.details.focused) {
      return "extension-body";
    }

    return "extension";
  }

  get focusTargets(): Renderable[] {
    return [
      this.details,
      this.search,
      this.list,
      this.input,
      this.editor,
      this.component.root,
    ].filter((node) =>
      node === this.search
        ? this.search.field.visible
        : node === this.editor
          ? this.editorField.visible
          : node.visible,
    );
  }

  get shortcuts(): FooterShortcut[] {
    if (this.scope?.dialog.kind === "custom") return [];
    const commands: [CommandId, string][] = [
      ["extension.submit", this.scope?.dialog.kind === "editor" ? "Save" : "Accept"],
      ["extension.dismiss", "Cancel"],
    ];
    if (this.url) {
      commands.push(["extension.browser", "Open URL"], ["extension.copy-url", "Copy URL"]);
    }

    return commands.map(([command, label]) => ({
      key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)),
      label,
    }));
  }

  update(scope?: Scope): void {
    if (this.disposed) {
      return;
    }
    if (!scope || scope.dialog.id === this.completedId) {
      this.hide();

      return;
    }
    if (
      this.scope?.dialog.id === scope.dialog.id &&
      this.scope.conversationId === scope.conversationId &&
      this.scope.sessionId === scope.sessionId
    ) {
      if (scope.dialog.kind === "custom") this.component.display(scope.dialog.frame);
      if (!this.visible) {
        this.root.visible = true;
        if (this.coveredFocus && !this.coveredFocus.isDestroyed) {
          this.coveredFocus.focus();
        } else {
          this.defaultFocus();
        }

        this.coveredFocus = undefined;
        this.actions.changed();
      }

      return;
    }

    this.hide();
    this.scope = scope;
    this.owner = this.renderer.currentFocusedRenderable ?? undefined;

    const dialog = scope.dialog;
    if (dialog.kind === "select") {
      const [title = "", ...details] = plain(dialog.title).split("\n");
      const description = details.join("\n").trim();

      this.search.setTitle(singleLine(title) || "Options");
      this.body.content = description;
      this.details.visible = Boolean(description);
    } else {
      this.body.content = plain(
        dialog.title + (dialog.kind === "confirm" ? `\n\n${dialog.message}` : ""),
      );
      this.details.visible = true;
    }

    this.input.value = "";
    this.input.placeholder = dialog.kind === "input" ? plain(dialog.placeholder ?? "") : "";
    this.input.visible = dialog.kind === "input";
    this.editorField.visible = dialog.kind === "editor";
    this.component.root.visible = dialog.kind === "custom";
    this.search.field.visible = dialog.kind === "select";
    this.list.visible = dialog.kind === "select" || dialog.kind === "confirm";
    if (dialog.kind === "editor") {
      this.details.visible = false;
      this.editorField.setTitle(singleLine(plain(dialog.title)));
      this.editor.setText(dialog.prefill);
    }
    if (dialog.kind === "custom") {
      this.details.visible = false;
      this.component.acceptsInput = true;
      this.component.connect({
        input: (bytes) =>
          this.sendComponent(scope, {
            requestId: dialog.id,
            input: new TextDecoder().decode(bytes),
          }),
        resize: (cols, rows) =>
          this.sendComponent(scope, {
            requestId: dialog.id,
            viewport: { cols: Math.min(200, cols), rows: Math.min(80, rows) },
          }),
        disconnect: async () => {},
      });
      this.component.display(dialog.frame);
    }

    if (dialog.kind === "select") {
      this.candidates = dialog.options.map((value) => ({ label: singleLine(plain(value)), value }));
    } else if (dialog.kind === "confirm") {
      this.candidates = [
        { label: "No", value: false },
        { label: "Yes", value: true },
      ];
    } else {
      this.candidates = [];
    }

    this.cursor = 0;
    this.search.clear();
    this.filter();
    this.busy = false;
    this.root.visible = true;
    this.resize();
    this.details.scrollTo(0);
    if (dialog.kind === "select") this.search.focus();
    else this.defaultFocus();

    this.actions.changed();
  }

  suspend(): void {
    if (!this.visible) {
      return;
    }

    this.coveredFocus = this.renderer.currentFocusedRenderable ?? undefined;
    this.root.visible = false;
    this.spinner.cancel();
  }

  private hide(): void {
    if (!this.visible && !this.scope) {
      return;
    }

    const restore = this.visible;
    this.coveredFocus = undefined;
    this.root.visible = false;
    this.scope = undefined;
    this.busy = false;
    this.spinner.cancel();
    this.input.value = "";
    this.editor.setText("");
    this.editorField.visible = false;
    this.component.suspend();
    this.component.root.visible = false;
    this.body.content = "";
    this.search.clear();
    this.candidates = [];
    this.filtered = [];
    this.paint();

    const owner = this.owner;
    this.owner = undefined;

    let available = !!owner && !owner.isDestroyed;
    for (let node = owner; node; node = node.parent as Renderable | undefined) {
      available &&= node.visible;
    }

    if (restore) {
      if (available && owner) {
        owner.focus();
      } else {
        this.actions.fallback();
      }
    }

    this.actions.changed();
  }

  private filter = (): void => {
    const match = createTextMatcher(this.search.value);
    this.filtered = this.candidates.filter((candidate) => match(candidate.label));
    this.search.setCounts({ matched: this.filtered.length, total: this.candidates.length });
    this.cursor = Math.max(0, Math.min(this.cursor, this.filtered.length - 1));
    this.paint();
  };

  private paint(): void {
    if (!this.list || this.list.isDestroyed) {
      return;
    }
    while (this.rows.length > this.filtered.length) {
      this.rows.pop()!.root.destroyRecursively();
    }

    const styles = uiTheme(this.renderer).styles;
    this.filtered.forEach((candidate, index) => {
      let row = this.rows[index];
      if (!row) {
        const root = new BoxRenderable(this.renderer, {
          id: `extension-option:${index}`,
          height: 1,
          width: "100%",
          flexShrink: 0,
          onMouseDown: (event) => {
            if (event.button === 0) {
              event.preventDefault();
              this.cursor = index;
              this.list.focus();
              this.paint();
            }
          },
        });
        const text = new TextRenderable(this.renderer, {
          height: 1,
          width: "100%",
          wrapMode: "none",
          selectable: false,
        });

        root.add(text);
        row = { root, text };
        this.rows.push(row);
        this.list.add(root);
      }

      row.text.content = candidate.label;

      const style = styles[index === this.cursor ? "ui.selection" : "ui.popup"];
      row.root.backgroundColor = style.bg;
      paintText(row.text, style);
    });

    const row = this.rows[this.cursor];
    if (row) {
      this.list.scrollChildIntoView(row.root.id);
    }

    this.layout.root.visible = this.list.visible;

    let emptyTitle: string | undefined;
    if (this.scope?.dialog.kind === "select" && !this.filtered.length) {
      emptyTitle = this.search.value ? "No matching options" : "No available options";
    }

    this.layout.results.showEmpty(emptyTitle);
  }

  available(command: CommandId): boolean {
    if (!this.visible || !command.startsWith("extension.")) {
      return false;
    }
    if (this.scope?.dialog.kind === "custom") return command === "extension.dismiss";
    if (
      this.scope?.dialog.kind === "editor" &&
      !["extension.submit", "extension.dismiss"].includes(command)
    )
      return false;
    if (command === "extension.search") {
      return this.scope?.dialog.kind === "select";
    }
    if (command === "extension.browser" || command === "extension.copy-url") {
      return !!this.url;
    }

    return true;
  }

  command(command: CommandId): void {
    if (!this.available(command)) {
      return;
    }
    if (command === "extension.dismiss") {
      this.launch(() => this.answer(true));

      return;
    }
    if (command === "extension.submit") {
      this.launch(() => this.answer(false));

      return;
    }
    if (command === "extension.search") {
      this.search.focus();

      return;
    }
    if (command === "extension.browser" || command === "extension.copy-url") {
      this.launch(() => this.useUrl(command === "extension.browser"));

      return;
    }

    const step = command === "extension.previous" || command === "extension.half-page-up" ? -1 : 1;
    const half = command === "extension.half-page-up" || command === "extension.half-page-down";
    if (
      ![
        "extension.previous",
        "extension.next",
        "extension.half-page-up",
        "extension.half-page-down",
      ].includes(command)
    ) {
      return;
    }
    if (this.details.focused) {
      this.details.scrollBy(step * (half ? halfPageStep(this.details.viewport.height) : 1));

      return;
    }
    if (this.input.focused) {
      return;
    }
    if (half && this.search.focused) {
      this.list.focus();
    }

    this.cursor = Math.max(
      0,
      Math.min(
        this.filtered.length - 1,
        this.cursor + step * (half ? halfPageStep(this.list.viewport.height) : 1),
      ),
    );
    this.paint();
    this.actions.changed();
  }

  private async answer(cancelled: boolean): Promise<void> {
    const scope = this.scope;
    if (!scope || this.busy) {
      return;
    }

    const candidate = this.filtered[this.cursor];
    if (
      !cancelled &&
      scope.dialog.kind !== "input" &&
      scope.dialog.kind !== "editor" &&
      !candidate
    ) {
      return;
    }

    let response: ExtensionUiResponse;
    if (cancelled) {
      response = { requestId: scope.dialog.id, cancelled: true };
    } else if (scope.dialog.kind === "editor") {
      response = { requestId: scope.dialog.id, value: this.editor.plainText };
    } else if (scope.dialog.kind === "input") {
      response = { requestId: scope.dialog.id, value: this.input.value };
    } else if (scope.dialog.kind === "confirm") {
      response = { requestId: scope.dialog.id, confirmed: candidate!.value === true };
    } else {
      response = { requestId: scope.dialog.id, value: String(candidate!.value) };
    }

    this.busy = true;
    this.spinner.start();

    let result: Result<void, ExpectedError>;
    try {
      result = await this.actions.answer(scope.sessionId, scope.conversationId, response);
    } finally {
      if (this.scope === scope) {
        this.busy = false;
        this.spinner.stop();
      }
    }
    if (this.scope !== scope) {
      return;
    }
    if (!result.ok) {
      this.actions.notice(`[${result.error.code}] ${result.error.message}`, {
        level: "error",
        source: "Extension",
      });

      return;
    }

    this.completedId = scope.dialog.id;
    this.hide();
  }

  private get url(): string | undefined {
    const dialog = this.scope?.dialog;

    return dialog
      ? plain(dialog.title + (dialog.kind === "confirm" ? `\n${dialog.message}` : "")).match(
          /https?:\/\/[^\s<>]+/u,
        )?.[0]
      : undefined;
  }

  private async useUrl(browser: boolean): Promise<void> {
    const url = this.url;
    if (!url) {
      return;
    }

    const result = browser ? await openLoginUrl(url) : await this.clipboard.copy(url);
    if (!result.ok) {
      this.actions.notice(`[${result.error.code}] ${result.error.message}`, { level: "error" });
    } else {
      this.actions.notice(
        browser ? "Authorization URL opened in the browser." : "Authorization URL copied.",
        { level: "success" },
      );
    }
  }

  private launch(operation: () => Promise<void>): void {
    void operation().catch((error) =>
      this.actions.notice(reportUnexpected(error, "extension dialog"), { level: "error" }),
    );
  }

  captureKey(key: KeyEvent, keymap: Keymap): boolean {
    const scope = this.scope;
    if (!this.visible || scope?.dialog.kind !== "custom") return false;
    const token = keyToken(key);
    if (
      keymap.bindings.some(
        (binding) => binding.keys[0] === token && inScope(binding.scope, "extension-custom"),
      )
    )
      return false;
    const plain = !key.ctrl && !key.meta && !key.shift && !key.super;
    const input =
      key.ctrl && key.name === "c" && !key.meta && !key.shift && !key.super
        ? "\u0003"
        : plain && ["return", "kpenter"].includes(key.name)
          ? "\r"
          : plain && key.name === "escape"
            ? "\u001b"
            : undefined;
    if (input === undefined) return false;
    // The shared router owns activation/cancellation until release. Other keys
    // remain native, including held list navigation, text editing and paste.
    this.sendComponent(scope, { requestId: scope.dialog.id, input });
    return true;
  }

  private sendComponent(scope: Scope, response: ExtensionUiResponse): void {
    this.componentQueue = this.componentQueue
      .then(async () => {
        if (this.scope !== scope) return;
        const result = await this.actions.answer(scope.sessionId, scope.conversationId, response);
        if (!result.ok && this.scope === scope) {
          this.actions.notice(result.error.message, { level: "error", source: "Extension" });
        }
      })
      .catch((error) => {
        this.actions.notice(reportUnexpected(error, "extension component"), { level: "error" });
      });
  }

  private defaultFocus(): void {
    if (this.scope?.dialog.kind === "custom") this.component.root.focus();
    else if (this.editorField.visible) this.editor.focus();
    else (this.input.visible ? this.input : this.list).focus();
  }

  private keepFocus = (): void => {
    if (!this.visible) {
      return;
    }
    for (
      let node = this.renderer.currentFocusedRenderable;
      node;
      node = node.parent as Renderable | null
    ) {
      if (node === this.root) {
        return;
      }
    }

    this.defaultFocus();
  };

  private resize = (): void => {
    if (this.disposed) {
      return;
    }

    const size =
      this.scope?.dialog.kind === "custom" || this.scope?.dialog.kind === "editor"
        ? POPUP_SIZES.expanded
        : this.scope && this.scope.dialog.kind !== "select"
          ? POPUP_SIZES.compact
          : POPUP_SIZES.standard;
    const { height } = centerPopup(this.panel, size, this.renderer.width, this.renderer.height);

    this.search.fit(Math.max(1, height - 5));
    if (this.editorField.visible) this.editorField.fit(Math.max(6, height - 2), height);
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.hide();
    this.disposed = true;
    this.component.dispose();
    this.renderer.off("resize", this.resize);
    this.renderer.off("focused_renderable", this.keepFocus);
    this.search.off(InputRenderableEvents.INPUT, this.filter);
    void this.clipboard
      .dispose()
      .catch((error) => reportUnexpected(error, "extension clipboard cleanup"));
  }
}
