import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CapabilityError, InputError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const scope = (model: Model<Api>) => JSON.stringify([model.provider, model.api, model.id]);
const supported = (model: Model<Api>) => model.api === "openai-responses" || model.api === "openai-codex-responses";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Session-local, explicitly opt-in priority requests. No global config writes or paid startup probes.
export class FastMode {
  private active = false;
  private readonly requested = new Map<string, boolean>();
  private readonly observed = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();

  readonly extension: InlineExtension = {
    name: "radian-fast", replaceable: true,
    factory: (pi) => {
      // A replaceable factory can run during discovery and then be omitted. Activate only when bound.
      pi.on("session_start", () => { this.active = true; });
      pi.on("model_select", () => this.changed());
      pi.on("session_shutdown", () => { this.active = false; this.requested.clear(); this.observed.clear(); this.listeners.clear(); });
      pi.registerCommand("fast", {
        description: "Toggle priority requests for this model in this session: /fast [on|off|status]. May increase usage.",
        getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
          const result = this.command(args, ctx.model);
          // Pi's command contract requires exceptions; normal domain validation remains a Result.
          if (!result.ok) throw result.error;
          ctx.ui.notify(`fast ${result.value ? "on" : "off"} (session only)${result.value ? " · priority may increase usage" : ""}`, "info");
        },
      });
    },
  };

  subscribe(changed: () => void): () => void { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  private changed(): void { for (const listener of this.listeners) listener(); }

  read(model: Model<Api> | undefined): boolean | null {
    if (!this.active || !model || !supported(model)) return null;
    const key = scope(model);
    return this.observed.get(key) ?? this.requested.get(key) ?? false;
  }

  command(args: string, model: Model<Api> | undefined): Result<boolean, InputError | CapabilityError> {
    const action = args.trim();
    if (!["", "on", "off", "status"].includes(action)) return err(new InputError("Usage: /fast [on|off|status]"));
    if (!this.active || !model || !supported(model)) return err(new CapabilityError("Priority requests are not supported by this model provider."));
    if (action === "status") return ok(this.read(model) === true);
    const enabled = action === "" ? this.read(model) !== true : action === "on";
    this.requested.set(scope(model), enabled); this.observed.delete(scope(model)); this.changed();
    return ok(enabled);
  }

  apply(payload: unknown, model: Model<Api>): unknown {
    if (!this.active || !supported(model) || !record(payload) || payload.model !== model.id) return payload;
    const requested = this.requested.get(scope(model));
    if (requested === true) return { ...payload, service_tier: "priority" };
    if (requested === false && (payload.service_tier === "priority" || payload.service_tier === "fast")) {
      const next = { ...payload }; delete next.service_tier; return next;
    }
    return payload;
  }

  observe(model: Model<Api>, enabled: boolean): void {
    if (this.active && supported(model)) this.observed.set(scope(model), enabled);
  }
}
