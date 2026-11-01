import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

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
  readonly purpose?: "planning" | undefined;
  /** Host-resolved delegation capability, frozen for this run. */
  readonly delegating?: boolean;
};

const planningTools = new Set(["read", "grep", "find", "ls"]);

function matcher(allowed?: readonly string[]): (name: string) => boolean {
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
  const planning = policy.purpose === "planning";
  // Planning runs stay read-only proposal leaves regardless of profile metadata.
  const delegating = policy.delegating === true && !planning;
  const allowed = matcher(policy.allowed);
  const excluded = new Set(delegating ? legacyDelegationTools : leafExcludedTools);
  const permits = (name: string) =>
    name === supervisorToolName ||
    (delegating && name === coordinatorTool) ||
    ((!planning || planningTools.has(name)) && allowed(name));
  return (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !excluded.has(name) && permits(name)));
    });
    // SDK nested tool calls emit this event too. Visibility is not the permission boundary.
    pi.on("tool_call", (event) => {
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
      return undefined;
    });
  };
}

export function leafPolicy(allowed?: readonly string[], purpose?: "planning"): ExtensionFactory {
  return childToolPolicy({ allowed, purpose });
}

export const leafExtension = leafPolicy();
