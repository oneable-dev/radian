import { Type, type Static } from "typebox";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { CapabilityError, InputError, SessionError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const id = Type.String({ minLength: 1, maxLength: 4096 });
const text = Type.String({ maxLength: 65536 });
export const extensionDialogSchema = Type.Union([
  Type.Object({ id, kind: Type.Literal("select"), title: text, options: Type.Array(text, { maxItems: 1000 }) }),
  Type.Object({ id, kind: Type.Literal("confirm"), title: text, message: text }),
  Type.Object({ id, kind: Type.Literal("input"), title: text, placeholder: Type.Optional(text) }),
]);
export type ExtensionDialog = Static<typeof extensionDialogSchema>;
export const extensionUiResponseSchema = Type.Union([
  Type.Object({ requestId: id, cancelled: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ requestId: id, value: text }, { additionalProperties: false }),
  Type.Object({ requestId: id, confirmed: Type.Boolean() }, { additionalProperties: false }),
]);
export type ExtensionUiResponse = Static<typeof extensionUiResponseSchema>;
export const extensionUiStateSchema = Type.Object({
  dialog: Type.Optional(extensionDialogSchema),
  notifications: Type.Array(Type.Object({ id, message: text, level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]) }), { maxItems: 8 }),
  statuses: Type.Record(Type.String(), text),
});
export type ExtensionUiState = Static<typeof extensionUiStateSchema>;
export const sessionExtensionUiSchema = Type.Object({ sessionId: id, conversationId: id, ...extensionUiStateSchema.properties });
export type SessionExtensionUi = Static<typeof sessionExtensionUiSchema>;
type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
type DialogRequest = WithoutId<ExtensionDialog>;
type Pending = { dialog: ExtensionDialog; finish(value?: string | boolean): void };

// This state is live UI transport, never part of ExecutionState or a saved conversation.
export class ExtensionUiBridge {
  readonly context: ExtensionUIContext;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly dialogListeners = new Set<() => void>();
  private notifications: ExtensionUiState["notifications"] = [];
  private readonly statuses = new Map<string, string>();
  private active = false;
  private disposed = false;

  constructor(base: ExtensionUIContext) {
    this.context = {
      ...base,
      select: async (title, options, opts) => await this.request({ kind: "select", title, options: [...options] }, opts) as string | undefined,
      input: async (title, placeholder, opts) => await this.request({ kind: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) }, opts) as string | undefined,
      confirm: async (title, message, opts) => (await this.request({ kind: "confirm", title, message }, opts)) === true,
      notify: (message, level = "info") => {
        if (!this.active || this.disposed) return;
        this.notifications = [...this.notifications.slice(-7), { id: crypto.randomUUID(), message: message.slice(0, 65536), level }]; this.changed();
      },
      setStatus: (key, value) => {
        if (this.disposed) return;
        const statusKey = key.slice(0, 4096);
        if (value === undefined) this.statuses.delete(statusKey);
        else if (this.statuses.has(statusKey) || this.statuses.size < 32) this.statuses.set(statusKey, value.slice(0, 65536));
        this.changed();
      },
      // RPC mode deliberately does not pretend to host Pi terminal components.
      custom: async () => { throw new CapabilityError("This extension requires Pi's custom terminal UI, which Radian does not host. Use a command accepting explicit arguments or Pi's terminal UI."); },
      editor: async () => { throw new CapabilityError("Extension multiline editors are not hosted in Radian yet. Basic input, selection and confirmation dialogs are supported."); },
    };
  }
  get state(): ExtensionUiState {
    const dialog = this.pending.values().next().value?.dialog;
    return { ...(dialog ? { dialog } : {}), notifications: [...this.notifications], statuses: Object.fromEntries(this.statuses) };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onDialog(listener: () => void): () => void { this.dialogListeners.add(listener); return () => { this.dialogListeners.delete(listener); }; }
  setActive(active: boolean): void {
    this.active = active && !this.disposed;
    if (!this.active) this.clear();
  }
  cancelDialogs(): void { for (const pending of [...this.pending.values()]) pending.finish(); }
  clear(): void {
    this.cancelDialogs();
    this.notifications = []; this.statuses.clear(); this.changed();
  }
  answer(response: ExtensionUiResponse): Result<void, ExpectedError> {
    const pending = this.pending.get(response.requestId);
    if (!pending) return err(new SessionError("SESSION_CONFLICT", "This extension dialog is no longer pending. No answer was delivered."));
    if ("cancelled" in response) { pending.finish(); return ok(undefined); }
    const dialog = pending.dialog;
    if (dialog.kind === "confirm") {
      if (!("confirmed" in response)) return err(new InputError("This extension dialog requires a confirmation."));
      pending.finish(response.confirmed); return ok(undefined);
    }
    if (!("value" in response) || response.value.length > 65536) return err(new InputError("This extension dialog requires a text answer of at most 65536 characters."));
    if (dialog.kind === "select" && !dialog.options.includes(response.value)) return err(new InputError("Choose one of the extension dialog's options."));
    pending.finish(response.value); return ok(undefined);
  }
  private request(request: DialogRequest, opts?: ExtensionUIDialogOptions): Promise<string | boolean | undefined> {
    if (!this.active || this.disposed || opts?.signal?.aborted) return Promise.resolve(undefined);
    if (this.pending.size >= 16) throw new CapabilityError("Too many pending extension dialogs. Finish or cancel an existing dialog first.");
    if (request.title.length > 65536 || request.kind === "select" && (request.options.length > 1000 || request.options.some(option => option.length > 65536))
      || request.kind === "input" && (request.placeholder?.length ?? 0) > 65536 || request.kind === "confirm" && request.message.length > 65536)
      throw new CapabilityError("The extension dialog exceeds Radian's UI transport limits.");
    const dialog: ExtensionDialog = { ...request, id: crypto.randomUUID() };
    const result = Promise.withResolvers<string | boolean | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: string | boolean) => {
      if (!this.pending.delete(dialog.id)) return;
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", cancel);
      result.resolve(value); this.changed();
    };
    const cancel = () => finish();
    this.pending.set(dialog.id, { dialog, finish });
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    // Even callers omitting a timeout cannot leave an unattended prompt forever.
    timer = setTimeout(cancel, Math.max(0, Math.min(opts?.timeout ?? 600000, 600000)));
    for (const listener of this.dialogListeners) listener();
    this.changed(); return result.promise;
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  dispose(): void { this.disposed = true; this.setActive(false); this.listeners.clear(); this.dialogListeners.clear(); }
}
