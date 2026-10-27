import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { discoverWorkspace } from "./roots.ts";

async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const child = Bun.spawn(["git", "-C", path, "init", "--initial-branch=main"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
}

test("Multiple roots collect repositories and display external linked worktrees exactly once", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // Discover nested projects repositories alongside separate hidden dotfiles repositories.
    const projects = join(fixture.directory, "projects"),
      nested = join(projects, "team", "service"),
      dotfiles = join(fixture.directory, ".dotfiles");
    await init(nested);
    await init(dotfiles);

    const result = expectOk(
      await discoverWorkspace({
        roots: [projects, dotfiles, fixture.main, fixture.feature, projects],
        maxDepth: 4,
      }),
    );

    // Merge identical common directories without restricting linked-worktree locations.
    expect(result.warnings).toEqual([]);
    expect(result.repositories).toHaveLength(3);
    expect(result.repositories.map((repo) => repo.name).sort()).toEqual([
      ".dotfiles",
      "main",
      "service",
    ]);
    expect(
      result.repositories
        .find((repo) => repo.id === fixture.repository.id)
        ?.worktrees.map((tree) => tree.path),
    ).toEqual([fixture.main, fixture.feature]);
  } finally {
    await fixture.cleanup();
  }
});

test("Discovery respects depth, dependency exclusions, and repository boundaries without scanning large internals", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // Repository internals and dependency directories are not separate workspace candidates.
    const projects = join(fixture.directory, "projects"),
      nested = join(projects, "team", "service");
    await init(nested);
    await init(join(projects, "node_modules", "dependency"));
    await init(join(nested, "embedded"));
    await symlink(projects, join(projects, "cycle"));

    const shallow = expectOk(await discoverWorkspace({ roots: [projects], maxDepth: 1 }));
    const deep = expectOk(await discoverWorkspace({ roots: [projects], maxDepth: 4 }));

    // Depth, repository boundaries, and symlink cycles prevent duplicate/internal repositories.
    expect(shallow.repositories).toEqual([]);
    expect(deep.repositories.map((repo) => repo.name)).toEqual(["service"]);
    expect(deep.warnings).toEqual([]);
    expect(expectError(await discoverWorkspace({ roots: [projects], maxDepth: -1 })).code).toBe(
      "INVALID_INPUT",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Explicit symlink roots canonicalize and broken/missing roots preserve valid repositories", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // Missing roots and invalid Git metadata must not hide healthy roots.
    const alias = join(fixture.directory, "alias"),
      broken = join(fixture.directory, "broken");
    await symlink(fixture.main, alias);
    await mkdir(join(broken, ".git"), { recursive: true });

    const result = expectOk(
      await discoverWorkspace({
        roots: [join(fixture.directory, "missing"), broken, alias, fixture.main],
        maxDepth: 4,
      }),
    );

    // Failures retain paths/stable codes and valid repositories remain deduplicated.
    expect(result.repositories.map((repo) => repo.id)).toEqual([fixture.repository.id]);
    expect(result.warnings.map(({ error }) => error.code)).toEqual([
      "STORAGE_FAILED",
      "GIT_DISCOVERY_FAILED",
    ]);
  } finally {
    await fixture.cleanup();
  }
});
