import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";

/** Host-owned coordination tool; granted only to roots and host-authorized delegators. */
export const coordinatorTool = "radian-subagent";
export const supervisorToolName = "radian-supervisor";

// Legacy and third-party delegation entry points stay blocked for every child, including
// delegators: their only delegation path is the host coordinator with run-tree limits.
export const legacyDelegationTools = [
  "radian_subagent",
  "subagent",
  "subagents_enable",
  "subagent_supervisor",
];
export const leafExcludedTools = [coordinatorTool, ...legacyDelegationTools];

export type ChildToolPolicy = {
  /** The profile's own allowlist. It never limits what a delegated target may use. */
  readonly allowed?: readonly string[] | undefined;
  readonly purpose?: "planning" | "analysis" | undefined;
  readonly bound?: boolean;
  /** Recheck durable host authority at every potentially mutating direct or nested call. */
  readonly authorize?: ((toolName: string) => Promise<Result<void, ExpectedError>>) | undefined;
  /** Host-resolved delegation capability, frozen for this run. */
  readonly delegating?: boolean;
};

export const planningTools = new Set(["read", "grep", "find", "ls"]);
export const hostReadOnlyTools = new Set([
  ...planningTools,
  supervisorToolName,
  "radian-task",
  coordinatorTool,
]);

export function matcher(allowed?: readonly string[]): (name: string) => boolean {
  const patterns = allowed?.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join(".*")}$`,
        "u",
      ),
  );
  return (name) => patterns === undefined || patterns.some((pattern) => pattern.test(name));
}

// Child reporting is independent of delegation. Common providers must never grant a
// child a new delegation capability, including legacy extension tools.
export function childToolPolicy(policy: ChildToolPolicy = {}): ExtensionFactory {
  const readOnly = policy.purpose === "planning" || policy.purpose === "analysis";
  const delegating = policy.delegating === true;
  const allowed = matcher(policy.allowed);
  const excluded = new Set(delegating ? legacyDelegationTools : leafExcludedTools);
  const permits = (name: string) =>
    name === supervisorToolName ||
    (delegating && name === coordinatorTool) ||
    (policy.bound === true && name === "radian-task") ||
    ((!readOnly || planningTools.has(name)) && allowed(name));
  return (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !excluded.has(name) && permits(name)));
    });
    // SDK nested tool calls emit this event too. Visibility is not the permission boundary.
    pi.on("tool_call", async (event) => {
      if (excluded.has(event.toolName))
        return {
          block: true,
          reason: delegating
            ? "Delegate only through radian-subagent."
            : "This Radian agent profile cannot delegate further work.",
        };
      if (!permits(event.toolName))
        return {
          block: true,
          reason: "This tool is outside the agent profile's allowlist.",
        };
      if (policy.authorize && !hostReadOnlyTools.has(event.toolName)) {
        // SDK 1.2 propagates handler exceptions into its fail-closed tool pipeline.
        // Do not disguise unexpected host errors as expected workflow refusals.
        const authorized = await policy.authorize(event.toolName);
        if (!authorized.ok)
          return {
            block: true,
            reason: `[${authorized.error.code}] ${authorized.error.message}`,
          };
      }
      return undefined;
    });
  };
}

export function leafPolicy(
  allowed?: readonly string[],
  purpose?: "planning" | "analysis",
): ExtensionFactory {
  return childToolPolicy({ allowed, purpose });
}

export const leafExtension = leafPolicy();
