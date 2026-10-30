import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { ResourceError, systemCode } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { ModelEffort } from "./model-selection.ts";

export type AgentProfile = {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: ModelEffort;
  readonly skills: readonly string[];
  readonly tools?: readonly string[];
  readonly prompt: string;
  readonly path: string;
};

const fields = new Set(["name", "description", "model", "thinking", "skills", "tools"]);
const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function readDefinition(path: string): Result<ReturnType<typeof parseFrontmatter>, ResourceError> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (cause) {
    if (!systemCode(cause)) throw cause;
    return err(new ResourceError(`Cannot read definition: ${path}`, { cause }));
  }
  try {
    return ok(parseFrontmatter(content));
  } catch (cause) {
    if (!(cause instanceof Error) || cause.name !== "YAMLParseError") throw cause;
    return err(new ResourceError(`Invalid YAML frontmatter: ${path}`, { cause }));
  }
}

export function readAgentProfile(path: string): Result<AgentProfile, ResourceError> {
  const parsed = readDefinition(path);
  if (!parsed.ok) return parsed;
  const { frontmatter: data, body } = parsed.value;
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
  return ok({
    name,
    description: data.description.trim(),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(data.thinking !== undefined ? { thinking: data.thinking as ModelEffort } : {}),
    skills: (data.skills ?? []) as string[],
    ...(data.tools !== undefined ? { tools: data.tools as string[] } : {}),
    prompt: body,
    path,
  });
}

export function discoverAgentProfiles(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
): Result<AgentProfile[], ResourceError> {
  const directories = [join(agentDir, "agents")];
  if (projectTrusted) {
    const ancestors: string[] = [];
    let directory = cwd;
    for (;;) {
      ancestors.unshift(join(directory, ".pi", "agents"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    directories.push(...ancestors);
  }
  const profiles = new Map<string, AgentProfile>();
  for (const directory of directories) {
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
      const parsed = readAgentProfile(join(directory, entry));
      if (!parsed.ok) return parsed;
      if (names.has(parsed.value.name))
        return err(new ResourceError(`Duplicate agent ${parsed.value.name} at ${directory}.`));
      names.add(parsed.value.name);
      profiles.set(parsed.value.name, parsed.value);
    }
  }
  return ok([...profiles.values()]);
}

export function childSkills(skills: Skill[]): Result<Skill[], ResourceError> {
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

export function roleInstructions(
  profile: AgentProfile,
  skills: readonly Skill[],
): Result<string, ResourceError> {
  const parts = [
    `<agent_role name=${JSON.stringify(profile.name)}>\n${profile.prompt}\n</agent_role>`,
  ];
  for (const name of profile.skills) {
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill)
      return err(
        new ResourceError(
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
