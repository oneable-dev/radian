import { expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeFiles } from "./completion-files.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

test("파일 후보는 현재 워크트리의 tracked·untracked 경로만 반환하고 ignore 파일은 제외한다", async () => {
  // Separate worktrees and ignored files reveal accidental repository-wide or filesystem-wide discovery.
  const app = await createWorktreeFixture();
  try {
    await mkdir(join(app.main, "src"));
    await writeFile(join(app.main, "src", "한글 file.ts"), "must not be included as content");
    await writeFile(join(app.main, ".gitignore"), "ignored.ts\n");
    await writeFile(join(app.main, "ignored.ts"), "ignored");
    await writeFile(join(app.feature, "feature-only.ts"), "other worktree");

    const result = expectOk(await completeFiles(app.main, ".ts"));

    expect(result.items.map((item) => item.value)).toEqual(["src/한글 file.ts"]);
    expect(expectOk(await completeFiles(app.main, "workspace")).items[0]?.value).toBe("workspace.txt");
    await unlink(join(app.main, "workspace.txt"));
    expect(expectOk(await completeFiles(app.main, "workspace")).items).toEqual([]);
    expect(expectOk(await completeFiles(app.main, "../")).items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("must not be included as content");
  } finally { await app.cleanup(); }
});

test("파일 조회 취소와 Git 조회 실패는 빈 성공 목록이 아닌 명시적 Result로 전달한다", async () => {
  const app = await createWorktreeFixture();
  try {
    // Both operations have deterministic outcomes without a network or a model request.
    expect(expectError(await completeFiles(app.main, "", AbortSignal.abort())).code).toBe("CANCELLED");
    expect(expectError(await completeFiles(app.directory, "")).code).toBe("GIT_QUERY_FAILED");
  } finally { await app.cleanup(); }
});
