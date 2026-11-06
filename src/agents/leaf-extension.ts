import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { AgentToolCeilingError, type ExpectedError } from "../errors.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import type { WorkflowBinding } from "./task-workflow.ts";
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
  readonly profile?: AgentProfile | undefined;
  readonly boundRole?: WorkflowBinding["role"] | undefined;
  readonly purpose?: "planning" | "analysis" | undefined;
  readonly bound?: boolean;
  /** Recheck durable host authority at every potentially mutating direct or nested call. */
  readonly authorize?: ((toolName: string) => Promise<Result<void, ExpectedError>>) | undefined;
  /** Host-resolved delegation capability, frozen for this run. */
  readonly delegating?: boolean;
};

/** Known Pi product-edit entry points; wrappers calling them still pass tool_call. */
export const productEditTools: ReadonlySet<string> = new Set(["edit", "write"]);

export const toolEnforcementSchema = Type.Object({
  toolPolicy: Type.Literal("host-enforced"),
  deniedProductEdit: Type.Boolean(),
  reachableUnsandboxed: Type.Array(Type.String()),
  verificationTrust: Type.Literal("host-trusted"),
  sandboxed: Type.Literal(false),
});
export type ToolEnforcement = Static<typeof toolEnforcementSchema>;

export function childToolCeiling(policy: ChildToolPolicy): readonly string[] | undefined {
  const profile = policy.profile;
  if (!profile?.builtin) return profile?.tools ?? policy.allowed;
  return (
    profile.effectiveProfile?.toolCeiling ??
    profile.toolCeiling ?? [...profile.builtin.toolCeiling, ...profile.builtin.verificationTools]
  );
}

function deniesProductEdit(policy: ChildToolPolicy): boolean {
  const builtin = policy.profile?.builtin;
  return (
    builtin?.id === "qa" ||
    (builtin?.workflowRoles.length === 1 &&
      builtin.workflowRoles[0] === "lead" &&
      policy.boundRole !== "implementer")
  );
}

/** Policy reachability, including patterns for tools registered later; never an OS sandbox. */
export function childToolEnforcement(policy: ChildToolPolicy): ToolEnforcement {
  const ceiling = childToolCeiling(policy);
  const allowed = matcher(ceiling);
  const readOnly = policy.purpose === "planning" || policy.purpose === "analysis";
  const mcp = (ceiling ?? ["*"])
    .filter((name) => name === "*" || name.startsWith("mcp__"))
    .map((name) => (name === "*" ? "mcp__*" : name));
  return {
    toolPolicy: "host-enforced",
    deniedProductEdit:
      readOnly ||
      deniesProductEdit(policy) ||
      [...productEditTools].every((name) => !allowed(name)),
    reachableUnsandboxed: readOnly
      ? []
      : [...["bash", "powershell"].filter(allowed), ...new Set(mcp)],
    verificationTrust: "host-trusted",
    sandboxed: false,
  };
}

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

const ceilingError = new AgentToolCeilingError(
  "This tool is outside the agent's host-enforced capability ceiling.",
);
const ceilingReason = `[${ceilingError.code}] ${ceilingError.message}`;

function childToolPermits(policy: ChildToolPolicy): (name: string) => boolean {
  const readOnly = policy.purpose === "planning" || policy.purpose === "analysis";
  const delegating = policy.delegating === true;
  const allowed = matcher(childToolCeiling(policy));
  const deniedProductEdit = deniesProductEdit(policy);
  return (name: string) =>
    name === supervisorToolName ||
    (delegating && name === coordinatorTool) ||
    (policy.bound === true && name === "radian-task") ||
    ((!deniedProductEdit || !productEditTools.has(name)) &&
      (!readOnly || planningTools.has(name)) &&
      allowed(name));
}

/** Pi 1.2.0 core/tools/index.ts allToolNames; never infer native names from extensions. */
const nativeTools = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** Denial-only replacements: no real native implementation or supplied argument is retained. */
export function childToolDenials(policy: ChildToolPolicy): ToolDefinition[] {
  if (!policy.profile?.builtin) return [];
  const permits = childToolPermits(policy);
  return nativeTools
    .filter((name) => !permits(name))
    .map((name) => ({
      name,
      label: name,
      description: "Host capability denial",
      exposure: "deferred",
      parameters: Type.Object({}),
      // Argument validation precedes tool_call; even malformed attempts need the denial code.
      prepareArguments: () => ({}),
      // Direct dispatch needs an active implementation. Hide its declaration, not its guard.
      prepareLoadout: () => ({ hiddenDeclarations: [name] }),
      execute: async () => ({
        isError: true,
        content: [{ type: "text", text: ceilingReason }],
        details: undefined,
      }),
    }));
}

// Child reporting is independent of delegation. Common providers must never grant a
// child a new delegation capability, including legacy extension tools.
export function childToolPolicy(policy: ChildToolPolicy = {}): ExtensionFactory {
  const delegating = policy.delegating === true;
  const excluded = new Set(delegating ? legacyDelegationTools : leafExcludedTools);
  const permits = childToolPermits(policy);
  // The session factory pairs these names with childToolDenials(policy) in SDK customTools.
  // SDK customTools take precedence over native and extension implementations of the same name.
  const denials = childToolDenials(policy).map((tool) => tool.name);
  return (pi) => {
    pi.on("before_agent_start", () => {
      pi.setActiveTools([
        ...pi.getActiveTools().filter((name) => !excluded.has(name) && permits(name)),
        ...denials,
      ]);
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
          reason: policy.profile?.builtin
            ? ceilingReason
            : "This tool is outside the agent profile's allowlist.",
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
