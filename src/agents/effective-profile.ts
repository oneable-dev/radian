import { createHash } from "node:crypto";
import { Type } from "typebox";
import { AgentConfigError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import { getBuiltinAgent } from "./builtin-agents.ts";
import type { ModelEffort } from "./model-selection.ts";

export type OverlaySource = {
  readonly path: string;
  readonly hash: string;
  readonly source: "personal" | "project" | "run";
};

export type AgentOverlay = OverlaySource & {
  readonly fields: unknown;
  readonly body: string;
};

export type EffectiveProfileSnapshot = {
  readonly id: string;
  readonly descriptorVersion: number;
  readonly promptHash: string;
  readonly overlays: readonly OverlaySource[];
  readonly model?: string;
  readonly thinking?: ModelEffort;
  readonly skills: readonly {
    readonly name: string;
    readonly path?: string;
    readonly hash?: string;
  }[];
  readonly toolCeiling: readonly string[];
  readonly verificationTools: readonly string[];
  readonly delegation: { readonly enabled: boolean };
  readonly purpose: "planning" | "analysis" | "execution";
  readonly outputContractVersions: readonly string[];
};

function snapshotSchema(strict: boolean) {
  const options = strict ? { additionalProperties: false } : {};
  return Type.Unsafe<EffectiveProfileSnapshot>(
    Type.Object(
      {
        id: Type.String(),
        descriptorVersion: Type.Integer({ minimum: 1 }),
        promptHash: Type.String(),
        overlays: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              hash: Type.String(),
              source: Type.Enum(["personal", "project", "run"]),
            },
            options,
          ),
        ),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(
          Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
        ),
        skills: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              path: Type.Optional(Type.String()),
              hash: Type.Optional(Type.String()),
            },
            options,
          ),
        ),
        toolCeiling: Type.Array(Type.String()),
        verificationTools: Type.Array(Type.String()),
        delegation: Type.Object({ enabled: Type.Boolean() }, options),
        purpose: Type.Enum(["planning", "analysis", "execution"]),
        outputContractVersions: Type.Array(Type.String()),
      },
      options,
    ),
  );
}

// Historical run records stay forward-compatible; durable admissions fail closed.
export const effectiveProfileSnapshotSchema = snapshotSchema(false);
export const strictEffectiveProfileSnapshotSchema = snapshotSchema(true);

export type EffectiveProfile = AgentProfile & {
  readonly effectiveProfile: EffectiveProfileSnapshot;
  readonly toolCeiling: readonly string[];
  readonly verificationTools: readonly string[];
};

export type EffectiveProfileSources = {
  /** Personal first, then ancestors farthest to nearest. Run choices are host inputs only. */
  readonly overlays: readonly AgentOverlay[];
  readonly projectTrusted: boolean;
  readonly scope?: "chat" | "code";
  readonly purpose?: EffectiveProfileSnapshot["purpose"];
  readonly availableSkills?: readonly { name: string; path?: string; hash?: string }[];
  readonly modelAvailable?: (model: string) => boolean;
};

const fields = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "skills",
  "tools",
  "delegation",
]);
const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const mapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());

export const profileHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

// Descriptor patterns admit concrete overlay names. A single wildcard is enough for
// the packaged ceilings; arbitrary overlapping glob languages are not authority proofs.
export function toolWithinCeiling(tool: string, ceiling: readonly string[]): boolean {
  return ceiling.some((allowed) => {
    if (allowed === "*") return true;
    if (tool === "*") return false;
    if (allowed === tool) return true;
    const wildcard = allowed.indexOf("*");
    if (wildcard < 0 || allowed.indexOf("*", wildcard + 1) >= 0) return false;
    const prefix = allowed.slice(0, wildcard);
    const suffix = allowed.slice(wildcard + 1);
    return (
      tool.startsWith(prefix) &&
      tool.endsWith(suffix) &&
      tool.length >= prefix.length + suffix.length
    );
  });
}

export function resolveEffectiveProfile(
  id: string,
  sources: EffectiveProfileSources,
  perRunChoice?: AgentOverlay,
): Result<EffectiveProfile, AgentConfigError> {
  const builtin = getBuiltinAgent(id);
  if (!builtin)
    return err(new AgentConfigError("AGENT_NAME_COLLISION", `Unknown built-in agent ${id}.`));
  const { descriptor } = builtin;
  let model: string | undefined;
  let thinking: ModelEffort | undefined;
  let description = builtin.description;
  let toolCeiling = [...descriptor.toolCeiling, ...descriptor.verificationTools];
  let toolsSpecified = false;
  let delegation = descriptor.delegation.enabled;
  const skills: string[] = [];
  const parts = [builtin.prompt];
  const overlays: OverlaySource[] = [];
  const selected = sources.overlays.filter(
    (overlay) =>
      overlay.source === "personal" ||
      (overlay.source === "project" && sources.projectTrusted && sources.scope !== "chat"),
  );
  if (perRunChoice) selected.push({ ...perRunChoice, source: "run" });

  for (const overlay of selected) {
    const invalid = (message: string) =>
      err(new AgentConfigError("AGENT_OVERLAY_FIELD", `${overlay.path}: ${message}`, overlay.path));
    const data = overlay.fields;
    if (!mapping(data)) return invalid("Expected an overlay mapping.");
    const unknown = Object.keys(data).filter((field) => !fields.has(field));
    if (unknown.length) return invalid(`Unsupported overlay fields: ${unknown.join(", ")}.`);
    if (
      data.name !== undefined &&
      (typeof data.name !== "string" || getBuiltinAgent(data.name)?.descriptor.id !== descriptor.id)
    )
      return err(
        new AgentConfigError(
          "AGENT_NAME_COLLISION",
          `${overlay.path}: overlay name must be ${descriptor.id}.`,
          overlay.path,
        ),
      );
    if (data.description !== undefined) {
      if (typeof data.description !== "string" || !data.description.trim())
        return invalid("Invalid description.");
      description = data.description.trim();
    }
    if (data.model !== undefined) {
      if (typeof data.model !== "string" || !/^[^/]+\/.+$/u.test(data.model))
        return invalid("model must use an exact provider/model identifier.");
      model = data.model;
    }
    if (data.thinking !== undefined) {
      if (typeof data.thinking !== "string" || !efforts.has(data.thinking))
        return invalid("Invalid thinking level.");
      thinking = data.thinking as ModelEffort;
    }
    if (data.skills !== undefined) {
      if (!strings(data.skills)) return invalid("skills must be a list of nonempty strings.");
      for (const skill of data.skills) if (!skills.includes(skill)) skills.push(skill);
    }
    if (data.tools !== undefined) {
      if (
        !strings(data.tools) ||
        data.tools.some((tool) => !/^[a-zA-Z0-9_*][a-zA-Z0-9_.*-]*$/u.test(tool))
      )
        return invalid("Invalid tools list.");
      const widened = data.tools.filter(
        (tool) => tool.includes("*") || !toolWithinCeiling(tool, toolCeiling),
      );
      if (widened.length)
        return err(
          new AgentConfigError(
            "AGENT_OVERLAY_WIDENS",
            `${overlay.path}: tools exceed the current ceiling: ${widened.join(", ")}.`,
            overlay.path,
          ),
        );
      toolCeiling = [...new Set(data.tools)];
      toolsSpecified = true;
    }
    if (data.delegation !== undefined) {
      if (
        !mapping(data.delegation) ||
        Object.keys(data.delegation).some((key) => key !== "enabled") ||
        typeof data.delegation.enabled !== "boolean"
      )
        return invalid("delegation must contain only enabled: true or false.");
      if (data.delegation.enabled && !delegation)
        return err(
          new AgentConfigError(
            "AGENT_OVERLAY_WIDENS",
            `${overlay.path}: delegation cannot be widened.`,
            overlay.path,
          ),
        );
      delegation = data.delegation.enabled;
    }
    overlays.push(
      Object.freeze({ path: overlay.path, hash: overlay.hash, source: overlay.source }),
    );
    if (overlay.body.trim())
      parts.push(
        `<agent_overlay source=${JSON.stringify(overlay.source)} path=${JSON.stringify(overlay.path)}>\n${overlay.body}\n</agent_overlay>`,
      );
  }
  if (model && sources.modelAvailable && !sources.modelAvailable(model))
    return err(
      new AgentConfigError(
        "AGENT_MODEL_UNAVAILABLE",
        `Agent ${descriptor.id} requires unavailable model ${model}.`,
      ),
    );
  const resolvedSkills: EffectiveProfileSnapshot["skills"][number][] = [];
  for (const name of skills) {
    const skill = sources.availableSkills?.find((item) => item.name === name);
    if (sources.availableSkills && !skill)
      return err(
        new AgentConfigError(
          "AGENT_SKILL_MISSING",
          `Agent ${descriptor.id} requires unavailable or parent-only skill ${name}.`,
        ),
      );
    resolvedSkills.push(
      Object.freeze({
        name,
        ...(skill?.path ? { path: skill.path } : {}),
        ...(skill?.hash ? { hash: skill.hash } : {}),
      }),
    );
  }
  const effectiveTools = Object.freeze(toolCeiling);
  const verificationTools = Object.freeze(
    toolCeiling.filter((tool) => toolWithinCeiling(tool, descriptor.verificationTools)),
  );
  const effectiveDelegation = Object.freeze({ enabled: delegation });
  const preferences = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  const snapshot: EffectiveProfileSnapshot = Object.freeze({
    id: descriptor.id,
    descriptorVersion: descriptor.descriptorVersion,
    promptHash: descriptor.promptHash,
    overlays: Object.freeze(overlays),
    ...preferences,
    skills: Object.freeze(resolvedSkills),
    toolCeiling: effectiveTools,
    verificationTools,
    delegation: effectiveDelegation,
    purpose: sources.purpose ?? "execution",
    outputContractVersions: Object.freeze(
      descriptor.outputContracts.map((contract) => `${contract}@1`),
    ),
  });
  const last = overlays.at(-1);
  return ok(
    Object.freeze({
      name: descriptor.id,
      description,
      ...preferences,
      skills: Object.freeze(skills),
      ...(toolsSpecified ? { tools: effectiveTools } : {}),
      toolCeiling: effectiveTools,
      verificationTools,
      delegation: effectiveDelegation,
      prompt: parts.join("\n\n"),
      path: last?.path ?? `radian:${descriptor.id}`,
      source: last?.source ?? "builtin",
      builtin: descriptor,
      effectiveProfile: snapshot,
    }),
  );
}

export function profileAdmission(profile: AgentProfile): Result<void, AgentConfigError> {
  const diagnostic = profile.diagnostics?.[0];
  return diagnostic
    ? err(new AgentConfigError(diagnostic.code, diagnostic.message, diagnostic.path))
    : ok(undefined);
}

/** Extension settings follow commandAgents through Pi's trust, CHAT and reload paths. */
export function builtInAgentsEnabled(settings: unknown): Result<boolean, AgentConfigError> {
  if (!mapping(settings) || settings.radian === undefined) return ok(true);
  if (!mapping(settings.radian))
    return err(new AgentConfigError("AGENT_OVERLAY_FIELD", "radian must be a settings mapping."));
  const flag = settings.radian.builtInAgents;
  if (flag === undefined || flag === "on") return ok(true);
  if (flag === "off") return ok(false);
  return err(
    new AgentConfigError("AGENT_OVERLAY_FIELD", "radian.builtInAgents must be 'on' or 'off'."),
  );
}
