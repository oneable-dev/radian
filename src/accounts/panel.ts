import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import {
  type AccountReply,
  type AccountRequest,
  type AccountsCatalog,
  type LoginView,
} from "./model.ts";
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
import {
  POPUP_SIZES,
  SearchPopupLayout,
  attachPopupActivity,
  centerPopup,
} from "../ui/popup-layout.ts";
import { paintText } from "../ui/theme-styles.ts";
import { footerKeyHint } from "../keybindings/footer.ts";
import type { CommandId, KeyContext } from "../keybindings/commands.ts";
import type { FooterShortcut } from "../ui/footer.ts";
import { reportUnexpected, type ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";
import { createTextMatcher } from "../search.ts";

export type AccountsActions = {
  request?: (
    request: AccountRequest,
    signal?: AbortSignal,
    refresh?: boolean,
  ) => Promise<Result<AccountReply, ExpectedError>>;
  cached?: (worktreeId: string) => Result<AccountsCatalog, ExpectedError> | undefined;
  openUrl?: (url: string) => Promise<Result<void, ExpectedError>>;
  copy?: (text: string) => Promise<Result<string, ExpectedError>>;
  changed: () => void;
  notice: Notice;
  fallback: () => void;
  keyHint: (command: CommandId, context: KeyContext) => string;
};

type Candidate = {
  id: string;
  label: string;
  detail: string;
  accountId?: string;
  choose: () => void;
  rename?: () => void;
};

type Stage = "accounts" | "providers" | "methods" | "label" | "rename" | "login" | "delete";

const stageTitles: Record<Stage, string> = {
  accounts: "Accounts",
  providers: "Providers",
  methods: "Sign-in methods",
  label: "Account label",
  rename: "Rename account",
  login: "Sign in",
  delete: "Delete account",
};

export class AccountsPanel {
  readonly root: BoxRenderable;
  readonly search: SearchInput;
  readonly list: ScrollBoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly layout: SearchPopupLayout;
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
  private catalogError: ExpectedError | undefined;
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
  private renameTarget: { provider: string; accountId: string | null } | undefined;
  private disposed = false;
  private readonly listenerBudget: number;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: AccountsActions,
  ) {
    // Account list, login body and the focus trap own these native layout subscriptions.
    this.listenerBudget = renderer.getMaxListeners() === 0 ? 0 : 4;
    if (this.listenerBudget) {
      renderer.setMaxListeners(renderer.getMaxListeners() + this.listenerBudget);
    }

    const theme = uiTheme(renderer);
    this.clipboard = new Clipboard(renderer);
    this.root = new BoxRenderable(renderer, {
      id: "accounts-picker",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      visible: false,
      zIndex: 5600,
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => event.stopPropagation(),
    });
    this.panel = new PopupFrame(renderer, {
      id: "accounts-dialog",
      position: "absolute",
      border: false,
      paddingX: 0,
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
    });
    this.spinner = new LoadingSpinner(renderer, { id: "accounts-loading" });
    this.search = new SearchInput(renderer, { id: "accounts-search", title: "Accounts" });
    this.message = new TextRenderable(renderer, {
      id: "accounts-message",
      height: 2,
      flexShrink: 0,
      wrapMode: "word",
      selectable: false,
    });
    this.message.onLifecyclePass = () => {
      this.message.visible = Boolean(this.message.plainText);
    };
    this.list = new ScrollBoxRenderable(renderer, {
      id: "accounts-list",
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
      onMouseDown: () => this.list.focus(),
    });
    this.details = new ScrollBoxRenderable(renderer, {
      id: "accounts-login-details",
      flexGrow: 1,
      minHeight: 0,
      scrollX: false,
      visible: false,
      onMouseDown: () => this.details.focus(),
    });
    this.body = new TextRenderable(renderer, {
      id: "accounts-login-body",
      width: "100%",
      wrapMode: "char",
      selectable: true,
    });
    this.details.add(this.body);
    this.input = new InputRenderable(renderer, {
      id: "accounts-input",
      width: "100%",
      visible: false,
      maxLength: 65536,
    });
    this.secret = new SecretInput(renderer);
    this.secret.visible = false;
    this.layout = new SearchPopupLayout(renderer, {
      id: "accounts",
      search: this.search,
      message: this.message,
      list: this.list,
    });
    this.panel.add(this.layout.root);
    this.panel.add(this.details);
    this.panel.add(this.input);
    this.panel.add(this.secret);
    attachPopupActivity(renderer, this.panel, this.spinner.root, () => {
      let body: Renderable;
      if (this.list.visible) {
        body = this.layout.results.root;
      } else if (this.details.visible) {
        body = this.details;
      } else if (this.input.visible) {
        body = this.input;
      } else {
        body = this.panel;
      }

      return {
        pending: this.busy,
        hasContent: this.catalog !== undefined || this.stage !== "accounts",
        message: "",
        title: this.search.field.visible ? this.search.field : undefined,
        body,
        anchor: this.list.visible ? this.rows[this.cursor] : undefined,
      };
    });
    this.root.add(this.panel);
    theme.scrollbars(this.list);
    theme.scrollbars(this.details);
    theme.input(this.input);
    theme.bindStyles(this.root, (styles) => {
      this.root.backgroundColor = styles["ui.backdrop"].bg;
      this.panel.backgroundColor = styles["ui.popup"].bg;
      paintText(this.message, styles["ui.muted"]);
      paintText(this.body, styles["ui.label"]);
      paintText(this.spinner.root, styles["status.working"]);
      this.paint();
    });
    this.search.on(InputRenderableEvents.INPUT, this.filter);
    renderer.on("resize", this.resize);
    renderer.on("focused_renderable", this.keepFocus);
    this.resize();
  }

  get visible(): boolean {
    return !this.disposed && !this.root.isDestroyed && this.root.visible;
  }

  get context(): KeyContext {
    if (this.secret.focused || this.input.focused) {
      return "accounts-input";
    } else if (this.search.focused) {
      return "accounts-search";
    } else {
      return "accounts";
    }
  }

  get focusTargets(): Renderable[] {
    return [this.search, this.list, this.details, this.input, this.secret].filter(
      (node) => node.visible && (node !== this.search || this.search.field.visible),
    );
  }

  get shortcuts(): readonly FooterShortcut[] {
    return (
      [
        ["accounts.choose", this.stage === "rename" ? "Save label" : "Continue"],
        ["accounts.dismiss", "Back / Cancel"],
        ["accounts.search", "Search"],
        ["accounts.previous", "Previous"],
        ["accounts.next", "Next"],
        ["accounts.half-page-down", "½ page"],
        ["accounts.rename", "Rename account"],
        ["accounts.delete", "Delete account"],
        ["accounts.browser", "Open browser"],
        ["accounts.copy-url", "Copy URL"],
        ["accounts.copy-code", "Copy code"],
      ] as const
    )
      .filter(
        ([command]) =>
          command !== "accounts.choose" ||
          (!this.busy &&
            (this.stage === "label" ||
              this.stage === "rename" ||
              (this.stage === "login" && !!this.flow?.prompt) ||
              (this.list.visible && this.filtered.length > 0))),
      )
      .filter(
        ([command]) =>
          command !== "accounts.rename" ||
          (this.stage === "accounts" && !this.busy && !!this.filtered[this.cursor]?.rename),
      )
      .filter(([command]) => command !== "accounts.search" || this.search.field.visible)
      .filter(
        ([command]) =>
          command !== "accounts.delete" ||
          (this.stage === "accounts" && !!this.filtered[this.cursor]?.accountId),
      )
      .filter(([command]) => command !== "accounts.copy-code" || !!this.code)
      .filter(
        ([command]) => !["accounts.browser", "accounts.copy-url"].includes(command) || !!this.url,
      )
      .map(([command, label]) => ({
        key: footerKeyHint(command, this.context, this.actions.keyHint(command, this.context)),
        label,
      }));
  }

  show(worktreeId: string): void {
    if (this.visible || this.disposed) {
      return;
    }

    this.owner = this.renderer.currentFocusedRenderable ?? undefined;
    this.worktreeId = worktreeId;
    this.epoch++;
    this.root.visible = true;
    this.stage = "accounts";
    this.catalog = undefined;
    this.catalogError = undefined;
    this.flow = undefined;
    this.promptId = undefined;
    this.menu("accounts", "", []);
    this.search.setCounts(null);
    this.resize();

    const cached = this.actions.cached?.(worktreeId);
    if (cached) {
      this.acceptCatalog(cached);
    } else {
      this.launch(() => this.load());
    }
  }

  updateData(): void {
    if (!this.visible || !this.worktreeId || this.busy || this.stage !== "accounts") {
      return;
    }

    const cached = this.actions.cached?.(this.worktreeId);
    if (cached && (!cached.ok || cached.value !== this.catalog)) {
      this.acceptCatalog(cached, true);
    }
  }

  private acceptCatalog(
    result: Result<AccountsCatalog, ExpectedError>,
    preserveSearch = false,
  ): void {
    if (!result.ok) {
      if (result.error !== this.catalogError) {
        this.actions.notice(`[${result.error.code}] ${result.error.message}`, {
          level: "error",
          source: "Accounts",
        });
      }
      this.catalogError = result.error;
      this.search.setCounts(null);
    } else {
      this.catalogError = undefined;
      this.catalog = result.value;
      this.main(preserveSearch);
      if (result.value.warning) {
        this.actions.notice(result.value.warning, { level: "warning", source: "Accounts" });
      }
    }

    this.actions.changed();
  }

  hide(restore = true): void {
    if (!this.visible) {
      return;
    }

    const worktreeId = this.worktreeId;
    const flow = this.flow;
    if (
      restore &&
      this.busy &&
      this.activeRequest &&
      ["select", "rename", "delete", "login", "answer"].includes(this.activeRequest)
    ) {
      this.actions.notice(
        "Account action is still settling. Closing does not undo an accepted save or selection; reopen /accounts to confirm before retrying.",
        { level: "warning" },
      );
    }

    this.activeRequest = undefined;
    this.epoch++;
    this.root.visible = false;
    this.watching?.abort();
    this.spinner.cancel();
    this.busy = false;
    this.pendingReload = false;
    this.flow = undefined;
    this.promptId = undefined;
    this.secret.clear();
    this.input.value = "";
    this.body.content = "";
    this.opened.clear();
    this.renameTarget = undefined;
    if (worktreeId && flow?.status === "pending") {
      this.launch(async () => {
        await this.actions.request?.({ type: "cancel", worktreeId, flowId: flow.id });
      });
    }

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

  updateScope(worktreeId: string | null): void {
    if (this.visible && worktreeId !== this.worktreeId) {
      this.hide();
    }
  }

  private launch(operation: () => Promise<void>): void {
    void operation().catch((error) => {
      const message = reportUnexpected(error, "accounts popup");
      if (this.visible) {
        this.actions.notice(message, { level: "error", source: "Accounts" });
      }
    });
  }

  private async perform(request: AccountRequest, refresh = false): Promise<void> {
    if (!this.actions.request || this.busy) {
      return;
    }

    const epoch = this.epoch;
    this.busy = true;
    this.activeRequest = request.type;
    this.spinner.start();
    if (request.type === "list") {
      this.search.setCounts(null);
    }

    let result: Result<AccountReply, ExpectedError>;
    try {
      result = await this.actions.request(request, undefined, refresh);
    } finally {
      if (this.visible && epoch === this.epoch) {
        this.busy = false;
        this.activeRequest = undefined;
        this.spinner.stop();
        if (this.pendingReload) {
          this.pendingReload = false;
          queueMicrotask(() => {
            if (this.visible && epoch === this.epoch) {
              this.launch(() => this.load());
            }
          });
        }
      }
    }
    if (!this.visible || epoch !== this.epoch) {
      if (result.ok && result.value.kind === "login" && result.value.login.status === "pending") {
        await this.actions.request({
          type: "cancel",
          worktreeId: request.worktreeId,
          flowId: result.value.login.id,
        });
      }

      return;
    }
    if (request.type === "answer" && this.flow?.id !== request.flowId) {
      return;
    }
    if (!result.ok) {
      this.actions.notice(`[${result.error.code}] ${result.error.message}`, {
        level: "error",
        source: "Accounts",
      });

      return;
    }
    if (result.value.kind === "catalog") {
      const preserveSearch =
        this.stage === "accounts" && (request.type === "list" || request.type === "select");
      this.catalog = result.value.catalog;
      this.main(preserveSearch);

      const warning = [result.value.warning, this.catalog.warning].filter(Boolean).join(" · ");
      if (warning) {
        this.actions.notice(warning, { level: "warning", source: "Accounts" });
      }
    } else {
      this.accept(result.value.login);
      if (request.type === "login") {
        this.launch(() => this.watch());
      }
    }

    this.actions.changed();
  }

  private async load(refresh = false): Promise<void> {
    if (this.worktreeId) {
      await this.perform({ type: "list", worktreeId: this.worktreeId }, refresh);
    }
  }

  private menu(
    stage: Stage,
    message: string,
    candidates: Candidate[],
    preserveSearch = false,
  ): void {
    this.stage = stage;
    this.search.setTitle(stageTitles[stage]);
    this.message.content = message;
    this.candidates = candidates;
    this.renameTarget = undefined;
    if (!preserveSearch) {
      this.cursor = 0;
      this.filtered = [];
    }

    this.secret.clear();
    this.secret.visible = this.input.visible = false;
    this.input.value = "";
    this.details.visible = false;
    this.body.content = "";
    this.search.field.visible = true;
    this.list.visible = true;
    if (!preserveSearch) {
      this.search.clear();
    }

    this.filter();
    this.resize();
    if (!preserveSearch) {
      this.search.focus();
    }
  }

  private main(preserveSearch = false): void {
    const catalog = this.catalog;
    const worktreeId = this.worktreeId;
    if (!catalog || !worktreeId) {
      return;
    }

    this.flow = undefined;
    this.promptId = undefined;

    const entries: Candidate[] = [
      {
        id: "add",
        label: "+ Add account",
        detail: "Sign in to another account",
        choose: () => this.providers(),
      },
    ];
    const names = new Map(catalog.providers.map((provider) => [provider.id, provider.name]));
    const existing = new Map(
      (catalog.existingAccounts ?? []).map((account) => [account.provider, account]),
    );
    for (const account of existing.values()) {
      names.set(account.provider, account.name);
    }

    const providers = new Set([
      ...existing.keys(),
      ...catalog.accounts.map((account) => account.provider),
    ]);
    for (const provider of [...providers].sort((a, b) =>
      (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
    )) {
      const name = names.get(provider) ?? provider;
      const choose = (accountId: string | null) =>
        this.launch(() =>
          this.perform({
            type: "select",
            worktreeId,
            provider,
            accountId,
            revision: catalog.revision,
          }),
        );
      const connection = existing.get(provider);
      if (connection) {
        const label =
          connection.label ?? (connection.type === "oauth" ? "Existing login" : "Existing API key");
        entries.push({
          id: `existing:${provider}`,
          label: `${name} · ${label}${catalog.selections[provider] ? "" : " [Active]"}`,
          detail: `${connection.type === "oauth" ? "OAuth" : "API key"} · already connected`,
          choose: () => choose(null),
          rename: () => this.rename(provider, null, label),
        });
      }
      for (const account of catalog.accounts.filter((account) => account.provider === provider)) {
        entries.push({
          id: account.id,
          accountId: account.id,
          label: `${name} · ${account.label}${catalog.selections[provider] === account.id ? " [Active]" : ""}`,
          detail: `${account.type === "oauth" ? "OAuth" : "API key"} · used by ${account.usedBy.length} worktree(s)`,
          choose: () => choose(account.id),
          rename: () => this.rename(provider, account.id, account.label),
        });
      }
    }

    this.menu("accounts", "", entries, preserveSearch);
  }

  private providers(): void {
    this.menu(
      "providers",
      "",
      (this.catalog?.providers ?? []).map((provider) => ({
        id: provider.id,
        label: provider.name,
        detail: "",
        choose: () => this.methods(provider),
      })),
    );
  }

  private methods(provider: AccountsCatalog["providers"][number]): void {
    this.provider = provider;
    this.menu(
      "methods",
      "",
      provider.methods.map((method) => ({
        id: method.id,
        label: method.name,
        detail: "",
        choose: () => {
          this.method = method.id;
          this.menu(
            "label",
            "Enter a label for the shared account, or press Enter to use the provider name.",
            [],
          );
          this.search.field.visible = this.list.visible = false;
          this.input.visible = true;
          this.input.placeholder = "Account label";
          this.input.maxLength = 128;
          this.input.focus();
          this.paint();
        },
      })),
    );
  }

  private accept(login: LoginView): void {
    if (this.flow?.id === login.id && this.flow.revision > login.revision) {
      return;
    }

    const first = this.stage !== "login" || this.flow?.id !== login.id;
    this.flow = login;
    if (login.status === "complete") {
      this.actions.notice(
        `Account added: ${singleLine(login.account?.label ?? "new account")}. Select it explicitly to use it in this worktree.`,
        { level: "success" },
      );
      this.main();
      if (this.busy) {
        this.pendingReload = true;
      } else {
        this.launch(() => this.load());
      }

      return;
    }
    if (login.status === "cancelled" || login.status === "error") {
      this.spinner.stop();
      this.main();
      this.actions.notice(
        login.error ?? "Login cancelled. Existing accounts and selections were retained.",
        { level: login.status === "error" ? "error" : "warning", source: "Accounts" },
      );

      return;
    }

    this.stage = "login";
    this.search.setTitle(stageTitles.login);
    this.resize();
    this.details.visible = true;
    this.body.content = login.events
      .map((event) =>
        [event.message, event.url, event.code ? `Code: ${event.code}` : undefined]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");

    const prompt = login.prompt;
    this.message.content =
      prompt?.message ??
      "Waiting for browser authentication… You can always copy or reopen the URL.";
    if (first || prompt?.id !== this.promptId) {
      this.promptId = prompt?.id;
      this.secret.clear();
      this.input.value = "";
      this.cursor = 0;
      this.candidates = (prompt?.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        detail: option.description ?? "",
        choose: () => this.answer(option.id),
      }));
      this.search.field.visible = this.list.visible = prompt?.type === "select";
      this.secret.visible = prompt?.type === "secret" || prompt?.type === "manual_code";
      this.input.visible = prompt?.type === "text";
      this.input.maxLength = 65536;
      this.input.placeholder = prompt?.placeholder ?? "Enter the requested value";
      this.search.clear();
      this.filter();
      if (this.secret.visible) {
        this.secret.focus();
      } else if (this.input.visible) {
        this.input.focus();
      } else if (this.search.field.visible) {
        this.search.focus();
      } else {
        this.details.focus();
      }
    }
    if (this.url && !this.opened.has(this.url)) {
      this.opened.add(this.url);
      this.launch(() => this.openBrowser());
    }

    this.actions.changed();
  }

  private async watch(): Promise<void> {
    this.watching?.abort();

    const controller = (this.watching = new AbortController());
    const epoch = this.epoch;
    while (
      this.visible &&
      epoch === this.epoch &&
      this.flow?.status === "pending" &&
      this.worktreeId &&
      !controller.signal.aborted
    ) {
      const flowId = this.flow.id;
      const result = await this.actions.request!(
        { type: "poll", worktreeId: this.worktreeId, flowId, revision: this.flow.revision },
        controller.signal,
      );
      if (
        !this.visible ||
        epoch !== this.epoch ||
        controller.signal.aborted ||
        this.flow?.id !== flowId ||
        this.flow.status !== "pending"
      ) {
        return;
      }
      if (!result.ok) {
        this.message.content = `[${result.error.code}] Login status is unknown. Close to cancel, or reopen accounts to check saved accounts.`;

        return;
      }
      if (result.value.kind !== "login") {
        this.message.content = "Unexpected login status reply.";

        return;
      }

      this.accept(result.value.login);
    }
  }

  private answer(value: string): void {
    if (!this.flow?.prompt || !this.worktreeId) {
      return;
    }

    const promptId = this.flow.prompt.id;
    this.secret.clear();
    this.input.value = "";
    this.launch(() =>
      this.perform({
        type: "answer",
        worktreeId: this.worktreeId!,
        flowId: this.flow!.id,
        promptId,
        value,
      }),
    );
  }

  private choose(): void {
    if (this.busy) {
      return;
    }
    if (this.stage === "label" && this.provider && this.worktreeId) {
      const label = this.input.value.trim() || this.provider.name;
      this.input.value = "";
      this.launch(() =>
        this.perform({
          type: "login",
          worktreeId: this.worktreeId!,
          provider: this.provider!.id,
          method: this.method,
          label,
        }),
      );

      return;
    }
    if (this.stage === "rename" && this.renameTarget && this.worktreeId && this.catalog) {
      const label = this.input.value.trim();
      if (!label) {
        this.message.content = "Account label must not be blank.";

        return;
      }

      const request: AccountRequest = {
        type: "rename",
        worktreeId: this.worktreeId,
        ...this.renameTarget,
        label,
        revision: this.catalog.revision,
      };
      this.launch(() => this.perform(request));

      return;
    }
    if (this.stage === "login" && (this.secret.visible || this.input.visible)) {
      this.answer(this.secret.visible ? this.secret.value : this.input.value);

      return;
    }

    this.filtered[this.cursor]?.choose();
  }

  private back(): void {
    if (this.stage === "accounts" || this.stage === "login" || this.busy) {
      this.hide();

      return;
    }
    if (this.stage === "methods") {
      this.providers();

      return;
    }
    if (this.stage === "label" && this.provider) {
      this.methods(this.provider);

      return;
    }

    this.main();
  }

  private rename(provider: string, accountId: string | null, label: string): void {
    this.menu(
      "rename",
      "Edit the account label. Labels are shared across worktrees; authentication and selections stay unchanged.",
      [],
    );
    this.renameTarget = { provider, accountId };
    this.search.field.visible = this.list.visible = false;
    this.input.visible = true;
    this.input.placeholder = "Account label";
    this.input.maxLength = 128;
    this.input.value = label;
    this.input.focus();
    this.paint();
  }

  private remove(): void {
    const accountId = this.filtered[this.cursor]?.accountId;
    const catalog = this.catalog;
    const worktreeId = this.worktreeId;
    if (this.stage !== "accounts" || !accountId || !catalog || !worktreeId || this.busy) {
      return;
    }

    const account = catalog.accounts.find((account) => account.id === accountId);
    if (!account) {
      return;
    }

    this.menu(
      "delete",
      `Remove ${singleLine(account.label)} and its saved credential from Radian. This does not delete the service account or conversations.`,
      [
        { id: "cancel", label: "Keep account", detail: "", choose: () => this.main() },
        {
          id: "delete",
          label: "Delete local account",
          detail: "Switch any worktrees using this account to another connected account first.",
          choose: () =>
            this.launch(() =>
              this.perform({ type: "delete", worktreeId, accountId, revision: catalog.revision }),
            ),
        },
      ],
    );
    if (account.usedBy.length) {
      this.details.visible = true;
      this.body.content = `Used by these worktrees:\n${account.usedBy.map((id) => singleLine(id)).join("\n")}\n\nSwitch them to another connected account before deleting.`;
    }
  }

  private get url(): string | undefined {
    return this.flow?.events.findLast((event) => event.url)?.url;
  }

  private get code(): string | undefined {
    return this.flow?.events.findLast((event) => event.code)?.code;
  }

  private async openBrowser(): Promise<void> {
    const url = this.url;
    const epoch = this.epoch;
    if (!url) {
      return;
    }

    const result = await (this.actions.openUrl ?? openLoginUrl)(url);
    if (this.visible && epoch === this.epoch && !result.ok) {
      this.actions.notice(result.error.message, { level: "error", source: "Accounts" });
    }
  }

  private async copy(code: boolean): Promise<void> {
    const text = code ? this.code : this.url;
    const epoch = this.epoch;
    if (!text) {
      return;
    }

    const result = await (this.actions.copy?.(text) ?? this.clipboard.copy(text));
    if (this.visible && epoch === this.epoch) {
      this.actions.notice(
        result.ok ? (code ? "Device code copied." : "Login URL copied.") : result.error.message,
        { level: result.ok ? "success" : "error", source: "Accounts" },
      );
    }
  }

  private filter = (): void => {
    const matches = createTextMatcher(this.search.value);
    const selected = this.filtered[this.cursor]?.id;

    this.filtered = this.candidates.filter((candidate) =>
      matches(`${candidate.label} ${candidate.detail}`),
    );
    this.search.setCounts(
      this.activeRequest === "list" || (this.stage === "accounts" && !this.catalog)
        ? null
        : { matched: this.filtered.length, total: this.candidates.length },
    );
    this.cursor = Math.max(
      0,
      this.filtered.findIndex((candidate) => candidate.id === selected),
    );
    for (const row of this.rows) {
      row.destroyRecursively();
    }

    this.rows.length = 0;
    this.filtered.forEach((candidate, index) => {
      const row = new BoxRenderable(this.renderer, {
        id: `accounts-row:${candidate.id}`,
        height: 1,
        flexShrink: 0,
        flexDirection: "column",
        minWidth: 0,
        onMouseDown: (event) => {
          if (event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            this.cursor = index;
            this.list.focus();
            this.paint();
          }
        },
      });
      const label = new TextRenderable(this.renderer, {
        content: singleLine(candidate.label),
        height: 1,
        wrapMode: "none",
        selectable: false,
      });
      uiTheme(this.renderer).bindStyles(row, (styles) => {
        paintText(label, styles["ui.label"]);
      });
      row.add(label);

      this.rows.push(row);
      this.list.add(row);
    });
    this.list.scrollTo(0);
    this.paint();
  };

  private paint(): void {
    if (!this.rows) {
      return;
    }

    const styles = uiTheme(this.renderer).styles;
    this.rows.forEach((row, index) => {
      row.backgroundColor = styles[index === this.cursor ? "ui.selection" : "ui.popup"].bg;
    });
    this.layout.results.root.visible = this.list.visible;
    this.layout.root.flexGrow = this.layout.candidates.flexGrow = this.list.visible ? 1 : 0;

    const noAccounts =
      this.stage === "accounts" &&
      !!this.catalog &&
      !this.catalog.accounts.length &&
      !this.catalog.existingAccounts?.length &&
      !this.search.value;
    // The add-account candidate remains actionable above the centered setup guidance.
    this.layout.results.empty.root.top = noAccounts ? this.filtered.length : 0;
    let emptyTitle: string | undefined;
    if (this.list.visible && !this.busy && this.catalog) {
      if (noAccounts) {
        emptyTitle = "No connected accounts";
      } else if (!this.filtered.length) {
        emptyTitle = this.search.value ? "No matching options" : "No available options";
      }
    }
    this.layout.results.showEmpty(
      emptyTitle,
      noAccounts ? "Choose Add account to sign in." : undefined,
    );

    const height = this.list.viewport.height;
    if (this.rows[this.cursor] && height > 0) {
      // Candidate indices are row offsets, including in a one-row confirmation viewport.
      if (this.cursor < this.list.scrollTop) {
        this.list.scrollTo(this.cursor);
      } else if (this.cursor >= this.list.scrollTop + height) {
        this.list.scrollTo(this.cursor - height + 1);
      }
    }

    this.actions.changed();
  }

  command(command: CommandId): void {
    if (!this.visible) {
      return;
    }
    if (command === "accounts.dismiss") {
      this.back();

      return;
    }
    if (command === "accounts.choose") {
      this.choose();

      return;
    }
    if (command === "accounts.rename") {
      if (this.stage === "accounts" && !this.busy) {
        this.filtered[this.cursor]?.rename?.();
      }

      return;
    }
    if (command === "accounts.delete") {
      this.remove();

      return;
    }
    if (command === "accounts.refresh") {
      if (this.stage === "accounts") {
        this.launch(() => this.load(true));
      }

      return;
    }
    if (command === "accounts.browser") {
      this.launch(() => this.openBrowser());

      return;
    }
    if (command === "accounts.copy-url" || command === "accounts.copy-code") {
      this.launch(() => this.copy(command === "accounts.copy-code"));

      return;
    }
    if (command === "accounts.search") {
      if (this.search.field.visible) {
        this.search.focus();
      }

      return;
    }

    const half = command === "accounts.half-page-up" || command === "accounts.half-page-down";
    const direction =
      command === "accounts.previous" || command === "accounts.half-page-up" ? -1 : 1;
    if (half && this.search.focused) {
      this.list.focus();
    }
    if (this.details.focused) {
      this.details.scrollBy(direction * (half ? halfPageStep(this.details.viewport.height) : 1));

      return;
    }
    if (!this.list.visible || this.busy) {
      return;
    }
    if (command === "accounts.previous" || command === "accounts.next" || half) {
      this.cursor = Math.max(
        0,
        Math.min(
          this.filtered.length - 1,
          this.cursor + direction * (half ? halfPageStep(this.list.viewport.height) : 1),
        ),
      );
      this.paint();
    }
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

    let target: Renderable;
    if (this.secret.visible) {
      target = this.secret;
    } else if (this.input.visible) {
      target = this.input;
    } else if (this.search.field.visible) {
      target = this.search;
    } else {
      target = this.details;
    }
    target.focus();
  };

  private resize = (): void => {
    if (this.disposed || this.root.isDestroyed) {
      return;
    }

    const size =
      this.stage === "label" || this.stage === "rename" || this.stage === "delete"
        ? POPUP_SIZES.compact
        : POPUP_SIZES.standard;
    const { height } = centerPopup(this.panel, size, this.renderer.width, this.renderer.height);

    this.search.fit(height - 5);
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.hide(false);
    this.disposed = true;
    this.watching?.abort();
    this.spinner.cancel();
    this.secret.clear();
    this.search.off(InputRenderableEvents.INPUT, this.filter);
    this.renderer.off("resize", this.resize);
    this.renderer.off("focused_renderable", this.keepFocus);
    if (!this.root.isDestroyed) {
      this.root.destroyRecursively();
    }

    void this.clipboard
      .dispose()
      .catch((error) => reportUnexpected(error, "account clipboard cleanup"));
    if (this.listenerBudget) {
      this.renderer.setMaxListeners(
        Math.max(1, this.renderer.getMaxListeners() - this.listenerBudget),
      );
    }
  }
}
