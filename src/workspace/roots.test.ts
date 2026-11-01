import { expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import {
  discoverConfiguredWorkspace,
  discoverWorkspace,
  workspacePathIsReachable,
} from "./roots.ts";

test.each([
  {
    label: "direct child",
    root: "/workspace",
    path: "/workspace/project",
    depth: 1,
    expected: true,
  },
  { label: "outside root", root: "/workspace", path: "/other/project", depth: 4, expected: false },
  {
    label: "root ancestor",
    root: "/workspace/private",
    path: "/workspace",
    depth: 4,
    expected: false,
  },
  {
    label: "reduced depth",
    root: "/workspace",
    path: "/workspace/team/project",
    depth: 1,
    expected: false,
  },
  {
    label: "dependency directory",
    root: "/workspace",
    path: "/workspace/node_modules/project",
    depth: 4,
    expected: false,
  },
  {
    label: "vendor directory",
    root: "/workspace",
    path: "/workspace/vendor/project",
    depth: 4,
    expected: false,
  },
  {
    label: "hidden directory",
    root: "/workspace",
    path: "/workspace/.hidden/project",
    depth: 4,
    expected: false,
  },
  {
    label: "explicit hidden root",
    root: "/workspace/.hidden",
    path: "/workspace/.hidden",
    depth: 0,
    expected: true,
  },
  {
    label: "explicit vendor root",
    root: "/workspace/vendor",
    path: "/workspace/vendor",
    depth: 0,
    expected: true,
  },
])(
  "Uncertainty eligibility follows scanner reachability for $label",
  ({ root, path, depth, expected }) => {
    // The configured input, not a previous catalog entry, determines the allowed traversal boundary.
    const reachable = workspacePathIsReachable(root, path, depth);

    // Failures may retain prior candidates only inside that same depth and exclusion contract.
    expect(reachable).toBe(expected);
  },
);

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
  if (code) {
    throw new Error(error);
  }
}

test("Multiple roots collect repositories and display external linked worktrees exactly once", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // Discover nested projects repositories alongside separate hidden dotfiles repositories.
    const projects = join(fixture.directory, "projects");
    const nested = join(projects, "team", "service");
    const dotfiles = join(fixture.directory, ".dotfiles");

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
    const projects = join(fixture.directory, "projects");
    const nested = join(projects, "team", "service");

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
    const alias = join(fixture.directory, "alias");
    const broken = join(fixture.directory, "broken");

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

test("Configured discovery uses the launch repository only for empty roots", async () => {
  const fixture = await createWorktreeFixture();
  try {
    const outside = join(fixture.directory, "outside");
    await mkdir(outside);

    // Empty roots select the repository containing the launch path, or nothing outside Git.
    const current = expectOk(
      await discoverConfiguredWorkspace({ roots: [], maxDepth: 4 }, fixture.feature),
    );
    const none = expectOk(await discoverConfiguredWorkspace({ roots: [], maxDepth: 4 }, outside));
    // Configured roots ignore the launch path entirely.
    const rooted = expectOk(
      await discoverConfiguredWorkspace({ roots: [outside], maxDepth: 4 }, fixture.main),
    );

    expect(current.repositories.map((repo) => repo.id)).toEqual([fixture.repository.id]);
    expect(none).toEqual({ repositories: [], warnings: [] });
    expect(rooted).toEqual({ repositories: [], warnings: [] });
  } finally {
    await fixture.cleanup();
  }
});

test("Roots containing deleted repositories report only current candidates", async () => {
  const fixture = await createWorktreeFixture();
  try {
    const projects = join(fixture.directory, "projects");
    const removed = join(projects, "removed");
    await init(removed);
    await init(join(projects, "kept"));
    await rm(removed, { recursive: true, force: true });

    // A previously discovered path produces neither a candidate nor a recurring warning.
    const result = expectOk(await discoverWorkspace({ roots: [projects], maxDepth: 2 }));

    expect(result.repositories.map((repo) => repo.name)).toEqual(["kept"]);
    expect(result.warnings).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
