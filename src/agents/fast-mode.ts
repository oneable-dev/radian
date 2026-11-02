import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CapabilityError, capture, InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { providerAdapter } from "../providers/index.ts";

const entryType = "radian.fast-mode.v1";
type FastChoice = Pick<Model<Api>, "provider" | "api" | "id"> & { enabled: boolean };
const scope = (model: Pick<Model<Api>, "provider" | "api" | "id">) =>
  JSON.stringify([model.provider, model.api, model.id]);
const supported = (model: Model<Api> | undefined) =>
  !!model && providerAdapter(model)?.fast.supports(model) === true;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const choice = (value: unknown): value is FastChoice =>
  record(value) &&
  typeof value.provider === "string" &&
  typeof value.api === "string" &&
  typeof value.id === "string" &&
  typeof value.enabled === "boolean";

// Session-local, explicitly opt-in priority requests. No global config writes or paid startup probes.
export class FastMode {
  private active = false;
  private readonly requested = new Map<string, boolean>();
  private readonly observed = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();

  readonly extension: InlineExtension = {
    name: "radian-fast",
    replaceable: true,
    factory: (pi) => {
      // A replaceable factory can run during discovery and then be omitted. Activate only when bound.
      pi.on("session_start", (_event, ctx) => {
        this.requested.clear();
        this.observed.clear();
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === "custom" && entry.customType === entryType && choice(entry.data)) {
            this.requested.set(scope(entry.data), entry.data.enabled);
          }
        }

        this.active = true;
        this.changed();
      });
      pi.on("model_select", () => this.changed());
      pi.on("session_shutdown", (event) => {
        this.active = false;
        if (event.reason !== "reload") {
          this.requested.clear();
          this.observed.clear();
          this.listeners.clear();
        }
      });
      pi.registerCommand("fast", {
        description:
          "Toggle Fast requests for this model in this session: /fast [on|off|status]. May increase usage.",
        getArgumentCompletions: (prefix) =>
          ["on", "off", "status"]
            .filter((value) => value.startsWith(prefix))
            .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
          const result = this.command(args, ctx.model);
          // Pi's command contract requires exceptions; normal domain validation remains a Result.
          if (!result.ok) {
            throw result.error;
          }

          if (args.trim() !== "status" && ctx.model) {
            const model = ctx.model;
            const saved = await capture(async () =>
              pi.appendEntry<FastChoice>(entryType, {
                provider: model.provider,
                api: model.api,
                id: model.id,
                enabled: result.value,
              }),
            );
            if (!saved.ok) {
              ctx.ui.notify(
                `fast ${result.value ? "on" : "off"} for this session, but the choice could not be saved [${saved.error.code}]. It may be lost after reload or restart.`,
                "warning",
              );

              return;
            }
          }

          ctx.ui.notify(
            `fast ${result.value ? "on" : "off"} (this conversation)${result.value ? ` · ${providerAdapter(ctx.model)?.fast.warning ?? "Fast requests may increase usage"}` : ""}`,
            "info",
          );
        },
      });
    },
  };

  subscribe(changed: () => void): () => void {
    this.listeners.add(changed);

    return () => this.listeners.delete(changed);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  read(model: Model<Api> | undefined): boolean | null {
    if (!this.active || !model || !supported(model)) {
      return null;
    }

    const key = scope(model);

    // An outgoing or confirmed observation never cancels an explicit user preference.
    return this.requested.get(key) ?? this.observed.get(key) ?? false;
  }

  command(
    args: string,
    model: Model<Api> | undefined,
  ): Result<boolean, InputError | CapabilityError> {
    const action = args.trim();
    if (!["", "on", "off", "status"].includes(action)) {
      return err(new InputError("Usage: /fast [on|off|status]"));
    }
    if (!this.active || !model || !supported(model)) {
      return err(new CapabilityError("Fast requests are not supported by this model connection."));
    }
    if (action === "status") {
      return ok(this.read(model) === true);
    }

    const enabled = action === "" ? this.read(model) !== true : action === "on";
    this.requested.set(scope(model), enabled);
    this.observed.delete(scope(model));
    this.changed();

    return ok(enabled);
  }

  apply(payload: unknown, model: Model<Api>): unknown {
    if (!this.active) {
      return payload;
    }

    const adapter = providerAdapter(model);

    return adapter ? adapter.fast.apply(payload, model, this.requested.get(scope(model))) : payload;
  }

  observe(model: Model<Api>, enabled: boolean): void {
    if (this.active && supported(model)) {
      this.observed.set(scope(model), enabled);
    }
  }
}
