import { Type, type Static } from "typebox";
import type {
  AgentSessionEvent,
  EventBus,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { CapabilityError, InputError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Subagent } from "./model.ts";
import { piSubagentsFromWidget } from "./pi-subagent-status.ts";
import { PiSubagentDisplay } from "./pi-subagent-display.ts";
import { ExtensionComponent } from "./extension-component.ts";
import { componentUiCapability } from "./extension-capabilities.ts";
import { readSubagentInspection } from "./pi-subagent-inspect.ts";
import {
  mcpStatusChannel,
  mcpStatusSchema,
  readMcpServers,
  summarizeMcpServers,
  type McpStatus,
} from "./mcp-status.ts";

const id = Type.String({ minLength: 1, maxLength: 4096 });
const text = Type.String({ maxLength: 65536 });

export const extensionDialogSchema = Type.Union([
  Type.Object({
    id,
    kind: Type.Literal("select"),
    title: text,
    options: Type.Array(text, { maxItems: 1000 }),
  }),
  Type.Object({ id, kind: Type.Literal("confirm"), title: text, message: text }),
  Type.Object({ id, kind: Type.Literal("input"), title: text, placeholder: Type.Optional(text) }),
  Type.Object({ id, kind: Type.Literal("editor"), title: text, prefill: text }),
  Type.Object({
    id,
    kind: Type.Literal("custom"),
    title: text,
    frame: Type.Object({
      cols: Type.Integer({ minimum: 2, maximum: 200 }),
      rows: Type.Integer({ minimum: 1, maximum: 80 }),
      revision: Type.Integer({ minimum: 0 }),
      ansi: Type.String({ maxLength: 1048576 }),
    }),
  }),
]);

export type ExtensionDialog = Static<typeof extensionDialogSchema>;

export const extensionUiResponseSchema = Type.Union([
  Type.Object({ requestId: id, cancelled: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ requestId: id, value: text }, { additionalProperties: false }),
  Type.Object({ requestId: id, confirmed: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ requestId: id, input: text }, { additionalProperties: false }),
  Type.Object(
    {
      requestId: id,
      viewport: Type.Object({
        cols: Type.Integer({ minimum: 2, maximum: 200 }),
        rows: Type.Integer({ minimum: 1, maximum: 80 }),
      }),
    },
    { additionalProperties: false },
  ),
]);

export type ExtensionUiResponse = Static<typeof extensionUiResponseSchema>;

export const extensionUiStateSchema = Type.Object({
  dialog: Type.Optional(extensionDialogSchema),
  notifications: Type.Array(
    Type.Object({
      id,
      message: text,
      level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
    }),
    { maxItems: 8 },
  ),
  statuses: Type.Record(Type.String(), text),
  mcp: Type.Optional(mcpStatusSchema),
});

export type ExtensionUiState = Static<typeof extensionUiStateSchema>;

export const sessionExtensionUiSchema = Type.Object({
  sessionId: id,
  conversationId: id,
  ...extensionUiStateSchema.properties,
});

export type SessionExtensionUi = Static<typeof sessionExtensionUiSchema>;

type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;

type DialogRequest = WithoutId<ExtensionDialog>;

type Pending = {
  dialog: ExtensionDialog;
  finish(value?: string | boolean): void;
  component?: ExtensionComponent;
};

// This state is live UI transport, never part of ExecutionState or a saved conversation.
export class ExtensionUiBridge {
  readonly context: ExtensionUIContext;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly dialogListeners = new Set<() => void>();
  private readonly terminalInputListeners = new Set<TerminalInputHandler>();
  private notifications: ExtensionUiState["notifications"] = [];
  private readonly statuses = new Map<string, string>();
  private mcp: McpStatus | undefined;
  private inspection: ReturnType<typeof readSubagentInspection> | undefined;
  private readonly unsubscribeMcp: (() => void) | undefined;
  private children: readonly Subagent[] = [];
  private childWidget: readonly string[] | undefined;
  private readonly childDisplay: PiSubagentDisplay;
  private childrenObservedAt = 0;
  private active = false;
  private disposed = false;

  constructor(
    base: ExtensionUIContext,
    events?: EventBus,
    private readonly agentDir?: string,
  ) {
    this.unsubscribeMcp = events?.on(mcpStatusChannel, (value) => {
      const result = readMcpServers(value);
      if (result.ok) {
        this.mcp = summarizeMcpServers(result.value);
      } else {
        console.warn(`[radian:mcp] ${result.error.code}: ${result.error.message}`);
        this.mcp = undefined;
      }

      this.changed();
    });
    this.childDisplay = new PiSubagentDisplay(events, () => {
      const result = piSubagentsFromWidget(this.childWidget, this.childDisplay.lookup);
      if (!result.ok) {
        console.warn(`[radian:subagents] ${result.error.code}: ${result.error.message}`);

        return;
      }

      this.children = result.value;
      this.changed();
    });
    this.context = {
      ...base,
      select: async (title, options, opts) =>
        (await this.request({ kind: "select", title, options: [...options] }, opts)) as
          | string
          | undefined,
      input: async (title, placeholder, opts) =>
        (await this.request(
          { kind: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) },
          opts,
        )) as string | undefined,
      confirm: async (title, message, opts) =>
        (await this.request({ kind: "confirm", title, message }, opts)) === true,
      onTerminalInput: (handler) => {
        if (this.disposed) return () => {};
        this.terminalInputListeners.add(handler);
        return () => {
          this.terminalInputListeners.delete(handler);
        };
      },
      notify: (message, level = "info") => {
        if (!this.active || this.disposed) {
          return;
        }

        this.notifications = [
          ...this.notifications.slice(-7),
          { id: crypto.randomUUID(), message: message.slice(0, 65536), level },
        ];
        this.changed();
      },
      setStatus: (key, value) => {
        if (this.disposed) {
          return;
        }

        const statusKey = key.slice(0, 4096);
        if (value === undefined) {
          this.statuses.delete(statusKey);
        } else if (this.statuses.has(statusKey) || this.statuses.size < 32) {
          this.statuses.set(statusKey, value.slice(0, 65536));
        }

        this.changed();
      },
      setWidget: (key, content) => {
        // Inspection commands emit and retract synchronously. Buffer the correlated
        // reply until command completion instead of losing it between snapshots.
        if (!this.disposed && key === "subagent-inspect") {
          if (content !== undefined) this.inspection = readSubagentInspection(content);
          return;
        }
        if (this.disposed || key !== "subagent-async") {
          return;
        }
        if (content !== undefined && !Array.isArray(content)) {
          return;
        }

        const result = piSubagentsFromWidget(content, this.childDisplay.lookup);
        if (!result.ok) {
          console.warn(`[radian:subagents] ${result.error.code}: ${result.error.message}`);

          return;
        }

        this.childWidget = content ? [...content] : undefined;
        this.children = result.value;
        this.childrenObservedAt = performance.now();
        this.changed();
      },
      custom: this.componentRequest as ExtensionUIContext["custom"],
      editor: async (title, prefill = "") =>
        (await this.request({ kind: "editor", title, prefill })) as string | undefined,
    };
    Object.defineProperty(this.context, componentUiCapability, {
      enumerable: true,
      value: () => this.active && !this.disposed,
    });
  }

  get subagents(): readonly Subagent[] {
    const elapsed = Math.max(0, performance.now() - this.childrenObservedAt);

    return this.children.map((child) =>
      child.status === "working" && child.runTiming
        ? {
            ...child,
            runTiming: { ...child.runTiming, elapsedMs: child.runTiming.elapsedMs + elapsed },
          }
        : child,
    );
  }

  get state(): ExtensionUiState {
    const pending = [...this.pending.values()].find(
      (item) => !item.component || item.component.visible,
    );
    const dialog =
      pending?.dialog.kind === "custom" && pending.component
        ? { ...pending.dialog, frame: pending.component.frame }
        : pending?.dialog;

    return {
      ...(dialog ? { dialog } : {}),
      notifications: [...this.notifications],
      statuses: Object.fromEntries(this.statuses),
      ...(this.mcp ? { mcp: { ...this.mcp } } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  onDialog(listener: () => void): () => void {
    this.dialogListeners.add(listener);

    return () => {
      this.dialogListeners.delete(listener);
    };
  }

  setActive(active: boolean): void {
    this.active = active && !this.disposed;
    if (!this.active) {
      this.clear();
    }
  }

  cancelDialogs(): void {
    const pending = [...this.pending.values()];
    for (const dialog of pending) {
      if (dialog.component) dialog.component.cancel();
      else dialog.finish();
    }
  }

  observeEvent(event: AgentSessionEvent): void {
    if (!this.disposed) {
      this.childDisplay.handleEvent(event);
    }
  }

  takeInspection(): ReturnType<typeof readSubagentInspection> | undefined {
    const reply = this.inspection;
    this.inspection = undefined;
    return reply;
  }

  reset(): void {
    this.inspection = undefined;
    this.terminalInputListeners.clear();
    this.mcp = undefined;
    this.children = [];
    this.childWidget = undefined;
    this.childDisplay.reset();
    this.clear();
  }

  clear(): void {
    this.cancelDialogs();
    this.notifications = [];
    this.statuses.clear();
    this.changed();
  }

  answer(response: ExtensionUiResponse): Result<void, ExpectedError> {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "This extension dialog is no longer pending. No answer was delivered.",
        ),
      );
    }
    if ("cancelled" in response) {
      if (pending.component) pending.component.cancel();
      else pending.finish();
      return ok(undefined);
    }
    if ("input" in response || "viewport" in response) {
      if (!pending.component) return err(new InputError("This dialog is not a custom component."));
      if ("input" in response) {
        if (response.input.length > 65536)
          return err(new InputError("Component input exceeds the transport limit."));
        const data = this.terminalInput(response.input);
        if (data !== undefined) pending.component.input(data);
      } else {
        const { cols, rows } = response.viewport;
        if (
          !Number.isInteger(cols) ||
          cols < 2 ||
          cols > 200 ||
          !Number.isInteger(rows) ||
          rows < 1 ||
          rows > 80
        ) {
          return err(new InputError("Component viewport is outside the supported limits."));
        }
        pending.component.resize(cols, rows);
      }
      return ok(undefined);
    }

    const dialog = pending.dialog;
    if (dialog.kind === "custom")
      return err(new InputError("Custom components require terminal input."));
    if (dialog.kind === "confirm") {
      if (!("confirmed" in response)) {
        return err(new InputError("This extension dialog requires a confirmation."));
      }

      pending.finish(response.confirmed);

      return ok(undefined);
    }
    if (!("value" in response) || response.value.length > 65536) {
      return err(
        new InputError("This extension dialog requires a text answer of at most 65536 characters."),
      );
    }
    if (dialog.kind === "select" && !dialog.options.includes(response.value)) {
      return err(new InputError("Choose one of the extension dialog's options."));
    }

    pending.finish(response.value);

    return ok(undefined);
  }

  private terminalInput(input: string): string | undefined {
    let data = input;
    // Reentrant subscriptions belong to the next input, not the current dispatch.
    const handlers = [...this.terminalInputListeners];
    for (const handler of handlers) {
      const result = handler(data);
      if (result?.consume) return undefined;
      data = result?.data ?? data;
    }
    return data;
  }

  interrupt(): void {
    this.terminalInput("\u0003");
    this.cancelDialogs();
  }

  private componentRequest = (
    factory: Parameters<ExtensionUIContext["custom"]>[0],
    options?: Parameters<ExtensionUIContext["custom"]>[1],
  ): Promise<unknown> => {
    if (this.pending.size >= 16) throw new CapabilityError("Too many pending extension dialogs.");
    const id = crypto.randomUUID();
    const result = Promise.withResolvers<unknown>();
    const finish = (value?: unknown) => {
      if (!this.pending.delete(id)) return;
      result.resolve(value);
      this.changed();
    };
    const component = new ExtensionComponent(
      this.context.theme,
      () => this.changed(),
      finish,
      this.agentDir,
    );
    this.pending.set(id, {
      dialog: { id, kind: "custom", title: "", frame: component.frame },
      finish,
      component,
    });
    for (const listener of this.dialogListeners) listener();
    this.changed();
    void component.initialize(factory, options).then(
      () => {
        if (!this.active || this.disposed) component.cancel();
      },
      (error: unknown) => {
        this.pending.delete(id);
        component.dispose();
        result.reject(error);
        this.changed();
      },
    );
    return result.promise;
  };

  private request(
    request: Exclude<DialogRequest, { kind: "custom" }>,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | boolean | undefined> {
    if (!this.active || this.disposed || opts?.signal?.aborted) {
      return Promise.resolve(undefined);
    }
    if (this.pending.size >= 16) {
      throw new CapabilityError(
        "Too many pending extension dialogs. Finish or cancel an existing dialog first.",
      );
    }
    if (
      request.title.length > 65536 ||
      (request.kind === "select" &&
        (request.options.length > 1000 ||
          request.options.some((option) => option.length > 65536))) ||
      (request.kind === "input" && (request.placeholder?.length ?? 0) > 65536) ||
      (request.kind === "editor" && request.prefill.length > 65536) ||
      (request.kind === "confirm" && request.message.length > 65536)
    ) {
      throw new CapabilityError("The extension dialog exceeds Radian's UI transport limits.");
    }

    const dialog: ExtensionDialog = { ...request, id: crypto.randomUUID() };
    const result = Promise.withResolvers<string | boolean | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: string | boolean) => {
      if (!this.pending.delete(dialog.id)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }

      opts?.signal?.removeEventListener("abort", cancel);
      result.resolve(value);
      this.changed();
    };
    const cancel = () => finish();

    this.pending.set(dialog.id, { dialog, finish });
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    // Even callers omitting a timeout cannot leave an unattended prompt forever.
    timer = setTimeout(cancel, Math.max(0, Math.min(opts?.timeout ?? 600000, 600000)));
    for (const listener of this.dialogListeners) {
      listener();
    }

    this.changed();

    return result.promise;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeMcp?.();
    this.mcp = undefined;
    this.children = [];
    this.childWidget = undefined;
    this.childDisplay.dispose();
    this.setActive(false);
    this.listeners.clear();
    this.dialogListeners.clear();
    this.inspection = undefined;
    this.terminalInputListeners.clear();
  }
}
