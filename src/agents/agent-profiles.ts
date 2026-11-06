import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import {
  AgentConfigError,
  ResourceError,
  systemCode,
  type AgentConfigDiagnostic,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { ModelEffort } from "./model-selection.ts";
import { builtinAgents, getBuiltinAgent, type BuiltinAgentDescriptor } from "./builtin-agents.ts";
import {
  profileAdmission,
  profileHash,
  resolveEffectiveProfile,
  type AgentOverlay,
  type EffectiveProfileSnapshot,
  type EffectiveProfileSources,
} from "./effective-profile.ts";

export type AgentProfile = {
  readonly name: string;
  readonly description: string;
  readonly source?: "builtin" | "personal" | "project" | "run";
  /** Immutable host identity; overlays cannot replace descriptor authority. */
  readonly builtin?: BuiltinAgentDescriptor;
  readonly effectiveProfile?: EffectiveProfileSnapshot;
  readonly toolCeiling?: readonly string[];
  readonly verificationTools?: readonly string[];
  readonly diagnostics?: readonly AgentConfigDiagnostic[];
  readonly model?: string;
  readonly thinking?: ModelEffort;
  readonly skills: readonly string[];
  readonly tools?: readonly string[];
  /**
   * Built-in overlays may narrow descriptor delegation; custom profiles opt in here.
   * For custom profiles, omitted and explicit false both mean a leaf. The profile's
   * tools restrict its own calls only; targets keep their own capabilities.
   */
  readonly delegation?: { readonly enabled: boolean };
  readonly prompt: string;
  readonly path: string;
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

function readDefinition(
  path: string,
): Result<
  ReturnType<typeof parseFrontmatter> & { hash: string },
  ResourceError | AgentConfigError
> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (cause) {
    if (!systemCode(cause)) throw cause;
    return err(new ResourceError(`Cannot read definition: ${path}`, { cause }));
  }
  try {
    return ok({ ...parseFrontmatter(content), hash: profileHash(content) });
  } catch (cause) {
    if (!(cause instanceof Error) || cause.name !== "YAMLParseError") throw cause;
    return err(
      new AgentConfigError("AGENT_OVERLAY_FIELD", `Invalid YAML frontmatter: ${path}`, path),
    );
  }
}

function definitionIdentity(path: string, declaredName: unknown) {
  const stem = basename(path, ".md");
  const declared = declaredName === undefined ? stem : declaredName;
  const fileRole = getBuiltinAgent(stem)?.descriptor.id;
  const declaredRole =
    typeof declared === "string" ? getBuiltinAgent(declared)?.descriptor.id : undefined;
  const roles = [...new Set([fileRole, declaredRole].filter((id) => id !== undefined))];
  const collision: AgentConfigDiagnostic | undefined =
    roles.length > 0 && fileRole !== declaredRole
      ? {
          code: "AGENT_NAME_COLLISION",
          message: `${path}: filename and declared name must identify the same built-in agent.`,
          path,
        }
      : undefined;
  return {
    name: declaredRole ?? fileRole ?? (typeof declared === "string" ? declared : stem),
    roles,
    collision,
  };
}

export function readAgentProfile(
  path: string,
  builtInAgents = true,
): Result<AgentProfile, ResourceError | AgentConfigError> {
  const parsed = readDefinition(path);
  if (!parsed.ok) return parsed;
  const { frontmatter: data, body, hash } = parsed.value;
  if (builtInAgents) {
    const identity = definitionIdentity(path, data?.name);
    if (identity.collision)
      return err(new AgentConfigError(identity.collision.code, identity.collision.message, path));
    if (getBuiltinAgent(identity.name))
      return resolveEffectiveProfile(identity.name, {
        overlays: [{ path, hash, source: "personal", fields: data, body }],
        projectTrusted: false,
      });
  }
  const invalid = (message: string) => err(new ResourceError(`${path}: ${message}`));
  if (!data || typeof data !== "object" || Array.isArray(data))
    return invalid("Expected a mapping.");
  const unknown = Object.keys(data).filter((key) => !fields.has(key));
  if (unknown.length) return invalid(`Unsupported agent fields: ${unknown.join(", ")}.`);
  const name = data.name ?? basename(path, ".md");
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(name)) {
    return invalid("Invalid agent name.");
  }
  if (typeof data.description !== "string" || !data.description.trim() || !body.trim()) {
    return invalid("An agent needs a description and role instructions.");
  }
  if (
    data.model !== undefined &&
    (typeof data.model !== "string" || !/^[^/]+\/.+$/u.test(data.model))
  ) {
    return invalid("model must use an exact provider/model identifier.");
  }
  if (
    data.thinking !== undefined &&
    (typeof data.thinking !== "string" || !efforts.has(data.thinking))
  ) {
    return invalid("Invalid thinking level.");
  }
  for (const key of ["skills", "tools"] as const) {
    const value = data[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      return invalid(`${key} must be a list of nonempty strings.`);
    }
  }
  if (
    Array.isArray(data.tools) &&
    data.tools.some((name: string) => !/^[a-zA-Z0-9_*][a-zA-Z0-9_.*-]*$/u.test(name))
  )
    return invalid("tools accepts names or '*' patterns, not default-selection modifiers.");
  if (builtInAgents && name === "main")
    return err(
      new AgentConfigError(
        "AGENT_NAME_COLLISION",
        `${path}: main is the root session, not an agent profile.`,
        path,
      ),
    );
  const delegation: unknown = data.delegation;
  if (delegation !== undefined) {
    if (!delegation || typeof delegation !== "object" || Array.isArray(delegation))
      return invalid("delegation must be a mapping such as { enabled: true }.");
    const keys = Object.keys(delegation);
    const unsupported = keys.filter((key) => key !== "enabled");
    if (unsupported.length)
      return invalid(`Unsupported delegation fields: ${unsupported.join(", ")}.`);
    if (!("enabled" in delegation) || typeof delegation.enabled !== "boolean")
      return invalid("delegation.enabled must be true or false.");
  }
  return ok({
    name,
    description: data.description.trim(),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(data.thinking !== undefined ? { thinking: data.thinking as ModelEffort } : {}),
    skills: (data.skills ?? []) as string[],
    ...(data.tools !== undefined ? { tools: data.tools as string[] } : {}),
    ...(delegation !== undefined
      ? {
          delegation: { enabled: (delegation as { enabled: boolean }).enabled },
        }
      : {}),
    prompt: body,
    path,
  });
}

export function findAgentProfile(
  profiles: readonly AgentProfile[],
  name: string,
): AgentProfile | undefined {
  return profiles.find(
    (profile) => profile.name === name || profile.builtin?.aliases.includes(name),
  );
}

export function discoverAgentProfiles(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  options: Omit<EffectiveProfileSources, "overlays" | "projectTrusted"> & {
    builtInAgents?: boolean;
  } = {},
): Result<AgentProfile[], ResourceError> {
  const directories: { path: string; source: "personal" | "project" }[] = [
    { path: join(agentDir, "agents"), source: "personal" },
  ];
  if (projectTrusted && options.scope !== "chat") {
    const ancestors: string[] = [];
    let directory = cwd;
    for (;;) {
      ancestors.unshift(join(directory, ".pi", "agents"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    directories.push(...ancestors.map((path) => ({ path, source: "project" as const })));
  }
  const profiles = new Map<string, AgentProfile>();
  const overlays = new Map<string, AgentOverlay[]>();
  const diagnostics = new Map<string, AgentConfigDiagnostic[]>();
  const enabled = options.builtInAgents !== false;
  const diagnose = (name: string, diagnostic: AgentConfigDiagnostic) => {
    diagnostics.set(name, [...(diagnostics.get(name) ?? []), diagnostic]);
  };
  for (const { path: directory, source } of directories) {
    let entries: string[];
    try {
      entries = readdirSync(directory)
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch (cause) {
      const code = systemCode(cause);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      if (!code) throw cause;
      return err(new ResourceError(`Cannot discover agents at ${directory}.`, { cause }));
    }
    const names = new Set<string>();
    for (const entry of entries) {
      const path = join(directory, entry);
      if (!enabled) {
        const parsed = readAgentProfile(path, false);
        if (!parsed.ok)
          return err(new ResourceError(parsed.error.message, { cause: parsed.error }));
        if (names.has(parsed.value.name))
          return err(new ResourceError(`Duplicate agent ${parsed.value.name} at ${directory}.`));
        names.add(parsed.value.name);
        profiles.set(parsed.value.name, parsed.value);
        continue;
      }
      const definition = readDefinition(path);
      if (!definition.ok) {
        if (definition.error instanceof ResourceError) return err(definition.error);
        // A broken alias file still belongs to its canonical role and reserves that identity.
        const { name } = definitionIdentity(path, undefined);
        if (getBuiltinAgent(name)) {
          if (names.has(name))
            diagnose(name, {
              code: "AGENT_NAME_COLLISION",
              message: `Duplicate agent ${name} at ${directory}.`,
              path,
            });
          names.add(name);
        }
        diagnose(name, {
          code: "AGENT_OVERLAY_FIELD",
          message: definition.error.message,
          path,
        });
        continue;
      }
      const { frontmatter: data, body, hash } = definition.value;
      const { name, roles, collision } = definitionIdentity(path, data?.name);
      if (collision) {
        // Neither spelling may redirect an overlay into a different built-in role.
        for (const role of roles) {
          diagnose(role, collision);
          names.add(role);
        }
        continue;
      }
      if (names.has(name)) {
        diagnose(name, {
          code: "AGENT_NAME_COLLISION",
          message: `Duplicate agent ${name} at ${directory}.`,
          path,
        });
        continue;
      }
      names.add(name);
      if (name === "main") {
        diagnose(name, {
          code: "AGENT_NAME_COLLISION",
          message: `${path}: main is the root session, not an agent profile.`,
          path,
        });
        continue;
      }
      if (getBuiltinAgent(name)) {
        overlays.set(name, [
          ...(overlays.get(name) ?? []),
          { path, hash, source, fields: data, body },
        ]);
        continue;
      }
      const parsed = readAgentProfile(path);
      if (!parsed.ok) {
        if (parsed.error.cause && systemCode(parsed.error.cause))
          return err(new ResourceError(parsed.error.message, { cause: parsed.error }));
        diagnose(name, { code: "AGENT_OVERLAY_FIELD", message: parsed.error.message, path });
        continue;
      }
      profiles.set(name, { ...parsed.value, source });
    }
  }
  if (!enabled) return ok([...profiles.values()]);
  for (const { descriptor } of builtinAgents) {
    const result = resolveEffectiveProfile(descriptor.id, {
      ...options,
      overlays: overlays.get(descriptor.id) ?? [],
      projectTrusted,
    });
    if (!result.ok)
      diagnose(descriptor.id, {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.path ? { path: result.error.path } : {}),
      });
    const fallback = result.ok
      ? result
      : resolveEffectiveProfile(descriptor.id, { overlays: [], projectTrusted: false });
    if (!fallback.ok) throw fallback.error;
    profiles.set(descriptor.id, fallback.value);
  }
  for (const [name, issues] of diagnostics) {
    const profile = profiles.get(name) ?? {
      name,
      description: "Unavailable agent configuration",
      skills: [],
      prompt: "",
      path: issues[0]?.path ?? name,
    };
    profiles.set(
      name,
      Object.freeze({
        ...profile,
        diagnostics: Object.freeze(issues.map((issue) => Object.freeze(issue))),
      }),
    );
  }
  return ok([...profiles.values()]);
}

export function childSkills(skills: Skill[]): Result<Skill[], ResourceError | AgentConfigError> {
  const visible: Skill[] = [];
  for (const skill of skills) {
    const parsed = readDefinition(skill.filePath);
    if (!parsed.ok) return parsed;
    const metadata: unknown = parsed.value.frontmatter.metadata;
    if (metadata && typeof metadata === "object" && "parentOnly" in metadata) {
      if (metadata.parentOnly !== "true" && metadata.parentOnly !== "false") {
        return err(
          new ResourceError(
            `${skill.filePath}: metadata.parentOnly must be the string "true" or "false".`,
          ),
        );
      }
      if (metadata.parentOnly === "true") continue;
    }
    visible.push(skill);
  }
  return ok(visible);
}

export function profileSkillSources(
  skills: Skill[],
): Result<
  readonly { name: string; path: string; hash: string }[],
  ResourceError | AgentConfigError
> {
  const visible = childSkills(skills);
  if (!visible.ok) return visible;
  const sources: { name: string; path: string; hash: string }[] = [];
  for (const skill of visible.value) {
    const parsed = readDefinition(skill.filePath);
    if (!parsed.ok) return parsed;
    sources.push({ name: skill.name, path: skill.filePath, hash: parsed.value.hash });
  }
  return ok(sources);
}

export function roleInstructions(
  profile: AgentProfile,
  skills: readonly Skill[],
): Result<string, ResourceError | AgentConfigError> {
  const admitted = profileAdmission(profile);
  if (!admitted.ok) return admitted;
  const parts = [
    `<agent_role name=${JSON.stringify(profile.name)}>\n${profile.prompt}\n</agent_role>`,
  ];
  for (const name of profile.skills) {
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill)
      return err(
        new AgentConfigError(
          "AGENT_SKILL_MISSING",
          `Agent ${profile.name} requires unavailable or parent-only skill ${name}.`,
        ),
      );
    const parsed = readDefinition(skill.filePath);
    if (!parsed.ok) return parsed;
    parts.push(
      `<required_skill name=${JSON.stringify(name)} path=${JSON.stringify(skill.filePath)}>\nResolve relative references against ${skill.baseDir}.\n${parsed.value.body}\n</required_skill>`,
    );
  }
  return ok(parts.join("\n\n"));
}

export function delegates(profile: AgentProfile | undefined): boolean {
  if (!profile) return false;
  return (
    profileAdmission(profile).ok &&
    profile.delegation?.enabled === true &&
    (!profile.builtin || profile.builtin.delegation.enabled)
  );
}
