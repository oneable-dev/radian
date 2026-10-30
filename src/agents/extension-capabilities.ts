import type { ExtensionUIContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { packageIdentity } from "./default-packages.ts";

// A local host capability, never serialized or persisted. Unlike ctx.hasUI it
// distinguishes a live component viewport from basic RPC input/selection support.
export const componentUiCapability = Symbol("radian.component-ui");
const prepared = new WeakSet<object>();

function hasComponentUi(ui: ExtensionUIContext): boolean {
  const available: unknown = Reflect.get(ui, componentUiCapability);
  return typeof available === "function" && available() === true;
}

/** Keep package handlers intact while supplying a TUI-capable context only to their UI commands. */
export function withComponentCommands(result: LoadExtensionsResult): LoadExtensionsResult {
  for (const extension of result.extensions) {
    const identity = packageIdentity(extension.path);
    if (!identity.ok) throw identity.error;
    if (identity.value !== "pi-mcp-adapter") continue;
    for (const command of extension.commands.values()) {
      if (prepared.has(command)) continue;
      const handler = command.handler;
      command.handler = (args, context) =>
        handler(
          args,
          hasComponentUi(context.ui)
            ? new Proxy(context, {
                get: (target, key, receiver) =>
                  key === "mode" ? "tui" : Reflect.get(target, key, receiver),
              })
            : context,
        );
      prepared.add(command);
    }
  }
  return result;
}
