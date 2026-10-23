import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config.ts";

test("Default roots are projects/dotfiles and empty roots select current-repository mode", () => {
  // Both requested roots apply without separate user settings.
  const defaults = expectOk(parseWorkspaceConfig({}));
  const local = expectOk(parseWorkspaceConfig({ roots: [] }));

  // Only explicit empty lists restore current-repository discovery.
  expect(defaults).toEqual({ roots: ["~/projects", "~/.dotfiles"], maxDepth: 4 });
  expect(local.roots).toEqual([]);
});

test.each([null, [], { roots: null }, { roots: [" "] }, { roots: [1] }, { roots: ["~another/repo"] }, { roots: ["x\0y"] }, { maxDepth: null }, { maxDepth: -1 }, { maxDepth: 11 }, { maxDepth: 1.5 }, { root: "wrong" }].map((value) => ({ value })))("Invalid workspace settings are rejected instead of defaulted: %j", ({ value }) => {
  // Invalid formats must not trigger unintended directory discovery.
  const error = expectError(parseWorkspaceConfig(value));

  // Callers can handle stable input error codes.
  expect(error.code).toBe("INVALID_INPUT");
});

test("Config-relative and home paths resolve independently of execution directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-workspace-config-"));
  try {
    // Relative roots belong to the config file's directory.
    const path = join(directory, "workspace.json");
    await writeFile(path, JSON.stringify({ roots: ["./repos", "~/projects", "~/.dotfiles"], maxDepth: 2 }));

    const config = expectOk(await loadWorkspaceConfig(path));

    // Expand home without relying on shell quoting or current working directories.
    expect(config).toEqual({ roots: [join(directory, "repos"), join(homedir(), "projects"), join(homedir(), ".dotfiles")], maxDepth: 2 });
    await writeFile(path, "{");
    expect(expectError(await loadWorkspaceConfig(path)).code).toBe("INVALID_INPUT");
    expect(expectError(await loadWorkspaceConfig(join(directory, "missing.json"))).code).toBe("STORAGE_FAILED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
