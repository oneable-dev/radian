import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { capture, InputError, StorageError, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { discoverOptionalRepository, discoverRepository } from "./discovery.ts";
import type { WorkspaceConfig } from "./config.ts";
import type { Repository } from "./model.ts";

export type DiscoveryWarning = { path: string; error: ExpectedError };

export type WorkspaceDiscovery = {
  repositories: readonly Repository[];
  warnings: readonly DiscoveryWarning[];
};

const excludedDirectories = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
]);
const maximumDirectories = 10000;

function scanDirectory(name: string): boolean {
  return !name.startsWith(".") && !excludedDirectories.has(name);
}

// Explicit roots bypass child-name exclusions, but descendants follow the scanner's exact rules.
export function workspacePathIsReachable(root: string, path: string, maxDepth: number): boolean {
  const suffix = relative(root, path);
  if (suffix === "") return true;
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) return false;
  const parts = suffix.split(sep);
  return parts.length <= maxDepth && parts.every(scanDirectory);
}

// Scan directory containers, not repository contents. Git owns the full linked-worktree list.
export async function discoverWorkspace(
  config: WorkspaceConfig,
): Promise<Result<WorkspaceDiscovery, InputError>> {
  if (!Number.isInteger(config.maxDepth) || config.maxDepth < 0 || config.maxDepth > 10) {
    return err(new InputError("Workspace maxDepth must be an integer from 0 to 10."));
  }

  const repositories = new Map<string, Repository>();
  const warnings: DiscoveryWarning[] = [];
  const visited = new Map<string, number>();
  const queue: { path: string; depth: number }[] = [];
  for (const root of config.roots) {
    const canonical = await capture(() => realpath(root));
    if (!canonical.ok) {
      warnings.push({ path: root, error: canonical.error });
      continue;
    }

    queue.push({ path: canonical.value, depth: 0 });
  }
  // A breadth-first scan gives overlapping roots the largest remaining depth budget.
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const remaining = config.maxDepth - current.depth;
    if ((visited.get(current.path) ?? -1) >= remaining) {
      continue;
    }
    if (visited.size >= maximumDirectories) {
      warnings.push({
        path: current.path,
        error: new InputError(
          `Workspace scan reached ${maximumDirectories} directories; use narrower roots.`,
        ),
      });
      break;
    }

    visited.set(current.path, remaining);

    const marker = await capture(() => lstat(join(current.path, ".git")));
    if (marker.ok) {
      const repository = await discoverRepository(current.path);
      if (repository.ok) {
        repositories.set(repository.value.id, repository.value);
      } else {
        warnings.push({ path: current.path, error: repository.error });
      }

      continue;
    }
    if (!(marker.error instanceof StorageError) || marker.error.systemCode !== "ENOENT") {
      warnings.push({ path: current.path, error: marker.error });
      continue;
    }
    if (remaining === 0) {
      continue;
    }

    const children = await capture(() => readdir(current.path, { withFileTypes: true }));
    if (!children.ok) {
      warnings.push({ path: current.path, error: children.error });
      continue;
    }
    for (const child of children.value.sort((a, b) => a.name.localeCompare(b.name))) {
      // Child symlinks are deliberately not followed; explicitly configured roots may be symlinks.
      if (child.isDirectory() && scanDirectory(child.name)) {
        queue.push({ path: join(current.path, child.name), depth: current.depth + 1 });
      }
    }
  }

  return ok({ repositories: [...repositories.values()], warnings });
}

/**
 * Determines current workspace membership from configuration and the filesystem/Git only.
 * `roots: []` selects the repository containing `cwd`, or none outside Git. Restoration
 * metadata such as previously persisted paths never contributes candidates.
 */
export async function discoverConfiguredWorkspace(
  config: WorkspaceConfig,
  cwd: string,
): Promise<Result<WorkspaceDiscovery, ExpectedError>> {
  if (config.roots.length) {
    return discoverWorkspace(config);
  }

  const discovered = await discoverOptionalRepository(cwd);
  if (!discovered.ok) {
    return discovered;
  }

  return ok({ repositories: discovered.value ? [discovered.value] : [], warnings: [] });
}
