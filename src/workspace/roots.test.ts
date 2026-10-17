import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";
import { discoverWorkspace } from "./roots.ts";

async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const child = Bun.spawn(["git", "-C", path, "init", "--initial-branch=main"], { stdout: "pipe", stderr: "pipe" });
  const [, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
}

test("여러 루트에서 레포를 모으고 루트 밖 linked worktree까지 한 번만 표시한다", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // projects의 중첩 레포와 별도의 숨김 dotfiles 레포를 함께 탐색한다.
    const projects = join(fixture.directory, "projects"), nested = join(projects, "team", "service"), dotfiles = join(fixture.directory, ".dotfiles");
    await init(nested); await init(dotfiles);

    const result = expectOk(await discoverWorkspace({ roots: [projects, dotfiles, fixture.main, fixture.feature, projects], maxDepth: 4 }));

    // 같은 common-dir은 합치며 linked worktree의 실제 위치를 제한하지 않는다.
    expect(result.warnings).toEqual([]);
    expect(result.repositories).toHaveLength(3);
    expect(result.repositories.map((repo) => repo.name).sort()).toEqual([".dotfiles", "main", "service"]);
    expect(result.repositories.find((repo) => repo.id === fixture.repository.id)?.worktrees.map((tree) => tree.path)).toEqual([fixture.main, fixture.feature]);
  } finally { await fixture.cleanup(); }
});

test("탐색 깊이와 의존성 제외 및 레포 경계를 지켜 대규모 내부 트리를 탐색하지 않는다", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // 실제 레포 내부와 의존성 디렉터리는 별도 워크스페이스 후보가 아니다.
    const projects = join(fixture.directory, "projects"), nested = join(projects, "team", "service");
    await init(nested); await init(join(projects, "node_modules", "dependency")); await init(join(nested, "embedded"));
    await symlink(projects, join(projects, "cycle"));

    const shallow = expectOk(await discoverWorkspace({ roots: [projects], maxDepth: 1 }));
    const deep = expectOk(await discoverWorkspace({ roots: [projects], maxDepth: 4 }));

    // 깊이 제한과 레포 경계 및 symlink 순환 때문에 중복이나 내부 레포가 생기지 않는다.
    expect(shallow.repositories).toEqual([]);
    expect(deep.repositories.map((repo) => repo.name)).toEqual(["service"]);
    expect(deep.warnings).toEqual([]);
    expect(expectError(await discoverWorkspace({ roots: [projects], maxDepth: -1 })).code).toBe("INVALID_INPUT");
  } finally { await fixture.cleanup(); }
});

test("명시한 symlink 루트는 정규화하고 일부 루트가 없거나 깨져도 정상 레포를 유지한다", async () => {
  const fixture = await createWorktreeFixture();
  try {
    // 누락 루트와 잘못된 Git 메타데이터가 다른 루트를 가리지 않아야 한다.
    const alias = join(fixture.directory, "alias"), broken = join(fixture.directory, "broken");
    await symlink(fixture.main, alias); await mkdir(join(broken, ".git"), { recursive: true });

    const result = expectOk(await discoverWorkspace({ roots: [join(fixture.directory, "missing"), broken, alias, fixture.main], maxDepth: 4 }));

    // 실패는 경로와 안정적인 코드로 전달되고 유효한 레포는 중복 없이 남는다.
    expect(result.repositories.map((repo) => repo.id)).toEqual([fixture.repository.id]);
    expect(result.warnings.map(({ error }) => error.code)).toEqual(["STORAGE_FAILED", "GIT_DISCOVERY_FAILED"]);
  } finally { await fixture.cleanup(); }
});
