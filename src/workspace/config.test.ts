import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expectError, expectOk } from "../testing/results.ts";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config.ts";

test("기본 탐색 루트는 projects와 dotfiles이고 빈 roots는 현재 레포 모드다", () => {
  // 요청한 두 루트는 별도의 사용자 설정이 없어도 적용된다.
  const defaults = expectOk(parseWorkspaceConfig({}));
  const local = expectOk(parseWorkspaceConfig({ roots: [] }));

  // 명시적인 빈 목록만 현재 레포 탐색으로 돌아간다.
  expect(defaults).toEqual({ roots: ["~/projects", "~/.dotfiles"], maxDepth: 4 });
  expect(local.roots).toEqual([]);
});

test.each([null, [], { roots: null }, { roots: [" "] }, { roots: [1] }, { roots: ["~another/repo"] }, { roots: ["x\0y"] }, { maxDepth: null }, { maxDepth: -1 }, { maxDepth: 11 }, { maxDepth: 1.5 }, { root: "wrong" }].map((value) => ({ value })))("잘못된 workspace 설정은 기본값으로 숨기지 않고 거부한다: %j", ({ value }) => {
  // 잘못된 형식은 의도하지 않은 디렉터리 탐색으로 이어지면 안 된다.
  const error = expectError(parseWorkspaceConfig(value));

  // 호출자가 안정적인 입력 오류 코드를 처리할 수 있다.
  expect(error.code).toBe("INVALID_INPUT");
});

test("설정 파일의 상대 경로와 홈 경로를 실행 디렉터리와 무관하게 해석한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radian-workspace-config-"));
  try {
    // 상대 루트는 설정 파일이 있는 디렉터리에 속한다.
    const path = join(directory, "workspace.json");
    await writeFile(path, JSON.stringify({ roots: ["./repos", "~/projects", "~/.dotfiles"], maxDepth: 2 }));

    const config = expectOk(await loadWorkspaceConfig(path));

    // 쉘의 따옴표나 현재 작업 경로에 의존하지 않고 홈을 확장한다.
    expect(config).toEqual({ roots: [join(directory, "repos"), join(homedir(), "projects"), join(homedir(), ".dotfiles")], maxDepth: 2 });
    await writeFile(path, "{");
    expect(expectError(await loadWorkspaceConfig(path)).code).toBe("INVALID_INPUT");
    expect(expectError(await loadWorkspaceConfig(join(directory, "missing.json"))).code).toBe("STORAGE_FAILED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
