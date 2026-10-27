import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { capture, InputError, parseJson, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export const defaultWorkspaceRoots = ["~/projects", "~/.dotfiles"] as const;
export type WorkspaceConfig = { roots: readonly string[]; maxDepth: number };

export function parseWorkspaceConfig(value: unknown): Result<WorkspaceConfig, InputError> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return err(new InputError("Workspace config must be an object."));
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== "roots" && key !== "maxDepth"))
    return err(new InputError("Workspace config supports roots and maxDepth only."));
  const roots = config.roots === undefined ? defaultWorkspaceRoots : config.roots;
  const maxDepth = config.maxDepth === undefined ? 4 : config.maxDepth;
  if (
    !Array.isArray(roots) ||
    !roots.every(
      (root): root is string =>
        typeof root === "string" &&
        root.trim().length > 0 &&
        !root.includes("\0") &&
        (!root.startsWith("~") || root === "~" || root.startsWith("~/")),
    )
  ) {
    return err(
      new InputError("Workspace roots must be paths; only ~ and ~/ support home expansion."),
    );
  }
  if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10)
    return err(new InputError("Workspace maxDepth must be an integer from 0 to 10."));
  return ok({ roots: [...roots], maxDepth });
}

export async function loadWorkspaceConfig(
  explicitPath?: string,
): Promise<Result<WorkspaceConfig, ExpectedError>> {
  const path = resolve(
    explicitPath ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "radian", "workspace.json"),
  );
  const read = await capture(() => readFile(path, "utf8"));
  let config: Result<WorkspaceConfig, InputError>;
  if (!read.ok) {
    if (explicitPath || !(read.error instanceof StorageError) || read.error.systemCode !== "ENOENT")
      return read;
    config = parseWorkspaceConfig({});
  } else {
    const json = parseJson(read.value, path);
    if (!json.ok) return json;
    config = parseWorkspaceConfig(json.value);
  }
  if (!config.ok)
    return err(new InputError(`${path}: ${config.error.message}`, { cause: config.error }));
  return ok(resolveWorkspaceConfig(config.value, path));
}

export function resolveWorkspaceConfig(config: WorkspaceConfig, path: string): WorkspaceConfig {
  return {
    ...config,
    roots: config.roots.map((root) =>
      root === "~"
        ? homedir()
        : root.startsWith("~/")
          ? resolve(homedir(), root.slice(2))
          : resolve(dirname(path), root),
    ),
  };
}
