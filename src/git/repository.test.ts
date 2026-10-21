import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository, maxPreviewBytes, parseStatus } from "./repository.ts";
import { fullFilePatch } from "./patch.ts";
import { describeCommit } from "./context.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "radian-git-view-"));
  const cwd = join(directory, "repo"); await mkdir(cwd);
  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", `core.hooksPath=${directory}/empty-hooks`, "-c", "commit.gpgsign=false",
      "-c", "user.name=Radian Test", "-c", "user.email=test@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(error); return output;
  };
  await git("init", "--initial-branch=main");
  const source = new GitRepository(cwd), signal = new AbortController().signal;
  const commit = async (message: string) => { await git("add", "--all"); await git("commit", "-m", message); };
  return { directory, cwd, git, source, signal, commit, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("커밋이 없는 저장소도 현재 staged 및 untracked 변경을 조회한다", async () => {
  // An unborn HEAD is a valid working tree, not a failed log to hide.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "staged.txt"), "staged\n"); await app.git("add", "staged.txt");
    await writeFile(join(app.cwd, "untracked.txt"), "new\n");

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const comparison = expectOk(await app.source.compare(snapshot.files.find((file) => file.kind === "staged")!, app.signal));

    expect(snapshot.commits).toEqual([]); expect(snapshot.reflog).toEqual([]); expect(snapshot.headOid).toBeNull();
    expect(snapshot.files.map((file) => file.kind)).toEqual(["staged", "untracked"]);
    expect(comparison.before).toBe(""); expect(comparison.after).toBe("staged\n");
  } finally { await app.cleanup(); }
});

test("같은 파일의 staged와 unstaged 비교는 HEAD/index/worktree를 구분한다", async () => {
  // Three versions of one path must never be collapsed into a single ambiguous diff.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "sample.ts"), "const value = 1;\n"); await app.commit("Initial\n\nFull body");
    await app.git("tag", "-a", "v1", "-m", "Release"); await app.git("branch", "other");
    await app.git("update-ref", "refs/remotes/origin/main", "HEAD");
    await writeFile(join(app.cwd, "sample.ts"), "const value = 2;\n"); await app.git("add", "sample.ts");
    await writeFile(join(app.cwd, "sample.ts"), "const value = 3;\n");

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const staged = expectOk(await app.source.compare(snapshot.files.find((file) => file.kind === "staged")!, app.signal));
    const unstaged = expectOk(await app.source.compare(snapshot.files.find((file) => file.kind === "unstaged")!, app.signal));
    const details = expectOk(await app.source.details(snapshot.commits[0]!, app.signal));

    expect(staged.before).toContain("= 1"); expect(staged.after).toContain("= 2");
    expect(unstaged.before).toContain("= 2"); expect(unstaged.after).toContain("= 3");
    expect(details.message).toContain("Full body"); expect(details.files[0]?.status).toBe("A");
    expect(snapshot.refs.map((ref) => [ref.kind, ref.name])).toContainEqual(["remote", "origin/main"]);
    expect(snapshot.refs.find((ref) => ref.name === "v1")?.oid).toBe(snapshot.commits[0]!.oid);
    expect(snapshot.reflog.length).toBeGreaterThan(0);
  } finally { await app.cleanup(); }
});

test("커밋 상세는 --points-at으로 해당 커밋을 직접 가리키는 브랜치·원격·태그만 표시한다", async () => {
  // 두 브랜치 tip보다 오래된 공통 조상과 관계없는 별도 root를 준비한다.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "sample.txt"), "first\n"); await app.commit("First"); const first = (await app.git("rev-parse", "HEAD")).trim();
    await writeFile(join(app.cwd, "sample.txt"), "second\n"); await app.commit("Second"); const second = (await app.git("rev-parse", "HEAD")).trim();
    await app.git("branch", "feature/topic"); await app.git("tag", "-a", "selected-tag", "-m", "Selected");
    await writeFile(join(app.cwd, "sample.txt"), "third\n"); await app.commit("Third"); const third = (await app.git("rev-parse", "HEAD")).trim();
    await app.git("tag", "future-tag");
    const unrelated = (await app.git("commit-tree", "HEAD^{tree}", "-m", "Unrelated root")).trim();
    await app.git("branch", "unrelated", unrelated);
    for (const [name, oid] of [["main", third], ["topic", second], ["unrelated", unrelated]] as const) await app.git("update-ref", `refs/remotes/origin/${name}`, oid);
    await app.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    // 조상을 포함하더라도 tip이 다르면 표시하지 않고 일치하는 ref만 반환한다.
    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const ancestor = expectOk(await app.source.details(snapshot.commits.find(commit => commit.oid === first)!, app.signal));
    const middle = expectOk(await app.source.details(snapshot.commits.find(commit => commit.oid === second)!, app.signal));
    const latest = expectOk(await app.source.details(snapshot.commits.find(commit => commit.oid === third)!, app.signal));

    expect(ancestor).toMatchObject({ branches: [] });
    expect(middle).toMatchObject({ branches: [{ kind: "local", name: "feature/topic", oid: second }, { kind: "remote", name: "origin/topic", oid: second }] });
    expect(latest).toMatchObject({ branches: [{ kind: "local", name: "main", oid: third }, { kind: "remote", name: "origin/main", oid: third }] });
    const text = describeCommit(middle, snapshot.refs, snapshot);
    expect(text).toContain("Branches: feature/topic\n"); expect(text).toContain("Remotes: origin/topic\n");
    expect(text).not.toContain("origin/main");
    expect(text).toContain("Tags: selected-tag"); expect(text).not.toContain("future-tag"); expect(text).not.toContain("unrelated");
  } finally { await app.cleanup(); }
});

test("reflog에만 남은 커밋도 해시로 조회하고 원래 부모 기준으로 변경을 비교한다", async () => {
  // reset 이후 모든 ref에서 사라졌지만 reflog에는 남아 있는 커밋을 준비한다.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "sample.txt"), "before\n"); await app.commit("Initial");
    const parent = (await app.git("rev-parse", "HEAD")).trim();
    await writeFile(join(app.cwd, "sample.txt"), "after\n"); await app.commit("Lost change\n\nComplete lost commit message");
    const lost = (await app.git("rev-parse", "HEAD")).trim(); await app.git("reset", "--hard", parent);

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const details = expectOk(await app.source.lookup(lost, app.signal));
    const comparison = expectOk(await app.source.compare(details.files[0]!, app.signal));

    expect(snapshot.commits.some(commit => commit.oid === lost)).toBe(false); expect(snapshot.reflog.some(event => event.oid === lost)).toBe(true);
    expect(details.commit).toMatchObject({ oid: lost, parents: [parent], subject: "Lost change", author: "Radian Test" });
    expect(details.message).toContain("Complete lost commit message"); expect(details.branches).toEqual([]);
    expect(comparison.before).toBe("before\n"); expect(comparison.after).toBe("after\n");
  } finally { await app.cleanup(); }
});

test("해시 조회의 잘못된 입력·취소·없는 커밋은 실패 Result로 구분한다", async () => {
  // 사용자 입력이나 취소를 유효한 빈 커밋으로 바꾸면 안 된다.
  const app = await fixture();
  try {
    const abort = new AbortController(); abort.abort();

    const invalid = await app.source.lookup("HEAD~1", app.signal), cancelled = await app.source.lookup("a".repeat(40), abort.signal);
    const missing = await app.source.lookup("f".repeat(40), app.signal);

    expect(expectError(invalid).code).toBe("GIT_PROTOCOL_ERROR"); expect(expectError(cancelled).code).toBe("CANCELLED");
    expect(expectError(missing).code).toBe("GIT_QUERY_FAILED");
  } finally { await app.cleanup(); }
});

test("브랜치 ref 조회가 취소되거나 커밋이 없으면 빈 브랜치 성공 대신 실패를 반환한다", async () => {
  // 실제 조회 경계에서도 미조회·취소·존재하지 않는 커밋을 빈 ref 결과와 구분한다.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "sample.txt"), "initial\n"); await app.commit("Initial");
    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const selected = snapshot.commits[0]!, abort = new AbortController(); abort.abort();

    const cancelled = await app.source.details(selected, abort.signal);
    const missing = await app.source.details({ ...selected, oid: "f".repeat(40) }, app.signal);

    expect(expectError(cancelled).code).toBe("CANCELLED"); expect(expectError(missing).code).toBe("GIT_QUERY_FAILED");
  } finally { await app.cleanup(); }
});

test("rename 및 개행 경로는 원본과 새 경로를 보존하고 전체 내용을 비교한다", async () => {
  // NUL parsing preserves paths that ordinary line splitting would corrupt.
  const app = await fixture();
  try {
    const before = "old name\nfile.txt", after = "-new name\nfile.txt";
    await writeFile(join(app.cwd, before), "unchanged content\n"); await app.commit("Initial");
    await rename(join(app.cwd, before), join(app.cwd, after)); await app.commit("Rename only");

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const details = expectOk(await app.source.details(snapshot.commits[0]!, app.signal));
    const comparison = expectOk(await app.source.compare(details.files[0]!, app.signal));

    expect(details.files[0]?.path).toBe(after); expect(details.files[0]?.originalPath).toBe(before);
    expect(comparison.before).toBe("unchanged content\n"); expect(comparison.after).toBe(comparison.before);
    expect(expectOk(fullFilePatch(comparison))).toContain(" unchanged content");
  } finally { await app.cleanup(); }
});

test("staged rename 뒤 unstaged 수정은 index의 새 경로를 비교한다", async () => {
  // Porcelain includes the old name for RM, but the index already owns the new name.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "old.txt"), "original\n"); await app.commit("Initial");
    await app.git("mv", "old.txt", "new.txt");
    await writeFile(join(app.cwd, "new.txt"), "edited after rename\n");

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const staged = expectOk(await app.source.compare(snapshot.files.find((file) => file.kind === "staged")!, app.signal));
    const unstaged = expectOk(await app.source.compare(snapshot.files.find((file) => file.kind === "unstaged")!, app.signal));

    expect(staged.before).toBe("original\n"); expect(staged.after).toBe("original\n");
    expect(unstaged.before).toBe("original\n"); expect(unstaged.after).toBe("edited after rename\n");
  } finally { await app.cleanup(); }
});

test("커밋 파일 조회는 첫 부모와 비교하고 삭제 파일의 After는 빈 내용이다", async () => {
  // Commit preview must remain historical after the working file has disappeared.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "gone.txt"), "old contents\n"); await app.commit("Initial");
    await app.git("rm", "gone.txt"); await app.commit("Delete");

    const snapshot = expectOk(await app.source.load(null, 300, app.signal));
    const details = expectOk(await app.source.details(snapshot.commits[0]!, app.signal));
    const comparison = expectOk(await app.source.compare(details.files[0]!, app.signal));

    expect(details.files[0]?.status).toBe("D");
    expect(comparison.before).toBe("old contents\n"); expect(comparison.after).toBe("");
    expect(comparison.beforeLabel).toContain(snapshot.commits[0]!.parents[0]!);
  } finally { await app.cleanup(); }
});

test("바이너리·큰 파일·심볼릭 링크를 조용히 잘라서 성공으로 표시하지 않는다", async () => {
  // All filesystem data is isolated; a symlink previews its target string, not the target file.
  const app = await fixture();
  try {
    await writeFile(join(app.cwd, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(app.cwd, "large"), Buffer.alloc(maxPreviewBytes + 1, 65));
    await symlink("outside-secret", join(app.cwd, "link"));
    const snapshot = expectOk(await app.source.load(null, 300, app.signal));

    const binary = await app.source.compare(snapshot.files.find((file) => file.path === "binary")!, app.signal);
    const large = await app.source.compare(snapshot.files.find((file) => file.path === "large")!, app.signal);
    const link = expectOk(await app.source.compare(snapshot.files.find((file) => file.path === "link")!, app.signal));

    expect(expectError(binary).code).toBe("GIT_PREVIEW_UNAVAILABLE");
    expect(expectError(large).code).toBe("GIT_PREVIEW_UNAVAILABLE");
    expect(link.after).toBe("outside-secret");
  } finally { await app.cleanup(); }
});

test("상태 파싱은 rename 레코드를 보존하고 손상된 레코드를 거절한다", () => {
  // The same renamed file can have both index and working-tree changes.
  const status = "RM new\nname\0old name\0?? loose\0";

  const files = expectOk(parseStatus(status));

  expect(files.map((file) => [file.kind, file.path, file.originalPath])).toEqual([
    ["staged", "new\nname", "old name"], ["unstaged", "new\nname", "old name"], ["untracked", "loose", undefined],
  ]);
  expect(expectError(parseStatus("R  new\0")).code).toBe("GIT_PROTOCOL_ERROR");
});

test.each(["AA", "DD", "AU", "UD", "UA", "DU", "UU"])("충돌 상태 %s는 일반 2-way 파일로 오인하지 않는다", async (status) => {
  // Some unmerged statuses have no U character, so the pair is the conflict identity.
  const files = expectOk(parseStatus(`${status} conflict.txt\0`));

  const result = await new GitRepository("/unused").compare(files[0]!, new AbortController().signal);

  expect(expectError(result).code).toBe("GIT_PREVIEW_UNAVAILABLE");
  expect(expectError(result).message).toContain("three-way");
});

test("취소된 조회는 취소 Result이고 존재하지 않는 ref는 조회 오류다", async () => {
  // Cancellation and a genuinely empty repository are different outcomes.
  const app = await fixture();
  try {
    const cancelled = new AbortController(); cancelled.abort();

    const result = await app.source.load(null, 300, cancelled.signal);
    const invalid = await app.source.load("refs/heads/missing", 300, app.signal);

    expect(expectError(result).code).toBe("CANCELLED");
    expect(expectError(invalid).code).toBe("GIT_QUERY_FAILED");
  } finally { await app.cleanup(); }
});
