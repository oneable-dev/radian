import { createHash } from "node:crypto";
import productLead from "../../resources/agents/product-lead.md" with { type: "text" };
import techLead from "../../resources/agents/tech-lead.md" with { type: "text" };
import uiUxLead from "../../resources/agents/ui-ux-lead.md" with { type: "text" };
import pm from "../../resources/agents/pm.md" with { type: "text" };
import engineer from "../../resources/agents/engineer.md" with { type: "text" };
import designer from "../../resources/agents/designer.md" with { type: "text" };
import qa from "../../resources/agents/qa.md" with { type: "text" };

export type BuiltinAgentDescriptor = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly workflowRoles: readonly ("lead" | "implementer" | "verifier" | "worker")[];
  readonly purposes: readonly ("planning" | "analysis" | "execution")[];
  readonly delegation: { readonly enabled: boolean };
  /** Declarative ceiling only; this registry does not install a tool policy or OS sandbox. */
  readonly toolCeiling: readonly string[];
  /** Verification access is not an OS sandbox; admission is enforced separately. */
  readonly verificationTools: readonly string[];
  readonly outputContracts: readonly string[];
  readonly descriptorVersion: number;
  /** SHA-256 of the exact packaged UTF-8 prompt asset, not of a legacy file's prose. */
  readonly promptHash: string;
};

export type BuiltinAgent = {
  readonly descriptor: BuiltinAgentDescriptor;
  readonly description: string;
  readonly prompt: string;
};

function defineBuiltin(
  id: string,
  description: string,
  prompt: string,
  workflowRoles: BuiltinAgentDescriptor["workflowRoles"],
  delegation: boolean,
  outputContracts: readonly string[],
  toolCeiling: readonly string[] = ["*"],
  verificationTools: readonly string[] = [],
): BuiltinAgent {
  return Object.freeze({
    description,
    prompt,
    descriptor: Object.freeze({
      id,
      aliases: Object.freeze([`radian:${id}`]),
      workflowRoles: Object.freeze([...workflowRoles]),
      purposes: Object.freeze(["planning", "analysis", "execution"] as const),
      delegation: Object.freeze({ enabled: delegation }),
      toolCeiling: Object.freeze([...toolCeiling]),
      verificationTools: Object.freeze([...verificationTools]),
      outputContracts: Object.freeze([...outputContracts]),
      descriptorVersion: verificationTools.length ? 2 : 1,
      promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
    }),
  });
}

export const builtinAgents: readonly BuiltinAgent[] = Object.freeze([
  defineBuiltin(
    "product-lead",
    "Own product requirements, scope and acceptance decisions.",
    productLead,
    ["lead"],
    true,
    ["publish-plan", "analysis"],
  ),
  defineBuiltin(
    "tech-lead",
    "Own engineering plans, implementation boundaries and technical analysis.",
    techLead,
    ["lead"],
    true,
    ["publish-plan", "analysis"],
  ),
  defineBuiltin(
    "ui-ux-lead",
    "Own interaction design, accessibility and design delivery plans.",
    uiUxLead,
    ["lead"],
    true,
    ["publish-plan", "analysis"],
  ),
  defineBuiltin(
    "pm",
    "Deliver bounded product research and documentation.",
    pm,
    ["implementer", "worker"],
    false,
    ["submit", "report"],
  ),
  defineBuiltin(
    "engineer",
    "Implement and validate bounded engineering work.",
    engineer,
    ["implementer", "worker"],
    false,
    ["submit", "report"],
  ),
  defineBuiltin(
    "designer",
    "Deliver bounded interface and interaction design work.",
    designer,
    ["implementer", "worker"],
    false,
    ["submit", "report"],
  ),
  defineBuiltin(
    "qa",
    "Independently verify current-revision behavior without editing product code.",
    qa,
    ["verifier", "worker"],
    false,
    ["finding", "verdict", "report"],
    [
      "read",
      "grep",
      "find",
      "ls",
      "web_enable",
      "web_search",
      "fetch_content",
      "get_search_content",
      "source_check",
      "radian-task",
      "radian-supervisor",
    ],
    ["bash", "mcp__*"],
  ),
]);

export function getBuiltinAgent(name: string): BuiltinAgent | undefined {
  return builtinAgents.find(
    ({ descriptor }) => descriptor.id === name || descriptor.aliases.includes(name),
  );
}
