import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const leafExcludedTools = [
  "radian-subagent",
  "radian_subagent",
  "subagent",
  "subagents_enable",
  "subagent_supervisor",
];

// Child reporting is independent of delegation. Common providers must never
// grant a leaf a new delegation capability, including legacy extension tools.
export function leafPolicy(allowed?: readonly string[]): ExtensionFactory {
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
  const permits = (name: string) =>
    name === "radian-supervisor" ||
    patterns === undefined ||
    patterns.some((pattern) => pattern.test(name));
  return (pi) => {
    const excluded = new Set(leafExcludedTools);
    pi.on("before_agent_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !excluded.has(name) && permits(name)));
    });
    // SDK nested tool calls emit this event too. Visibility is not the permission boundary.
    pi.on("tool_call", (event) => {
      if (excluded.has(event.toolName))
        return { block: true, reason: "Radian leaf sessions cannot delegate further work." };
      if (!permits(event.toolName))
        return { block: true, reason: "This tool is outside the agent profile's allowlist." };
      return undefined;
    });
  };
}

export const leafExtension = leafPolicy();
