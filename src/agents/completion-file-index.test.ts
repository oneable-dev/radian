import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as discovery from "./completion-files.ts";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompletionFileIndex } from "./completion-file-index.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

async function mount() {
  const fixture = await createWorktreeFixture(), listeners = new Set<() => void>(), unexpected: unknown[] = [];
  let changes = 0;
  const index = new CompletionFileIndex(fixture.main, () => { changes++; for (const listener of listeners) listener(); }, error => unexpected.push(error));
  const paths = (query = "") => {
    const result = index.read(query);
    return result?.ok ? result.value.items.map(item => item.value) : [];
  };
  const until = (predicate: () => boolean, label = "file update") => new Promise<void>((resolve, reject) => {
    if (predicate()) { resolve(); return; }
    const check = () => { if (predicate()) { clearTimeout(timer); listeners.delete(check); resolve(); } };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`File index observation timed out (${label}): ${JSON.stringify(index.read(""))}`)); }, 3000);
    listeners.add(check);
  });
  return { ...fixture, index, paths, until, unexpected, changes: () => changes,
    async cleanup() { index.dispose(); listeners.clear(); await fixture.cleanup(); } };
}

test("파일 인덱스는 전체 목록을 준비하고 반복 입력은 I/O 없이 메모리에서 검색한다", async () => {
  // 첫 페이지 밖의 파일과 ignored 파일을 함께 준비해 불완전한 캐시를 탐지한다.
  const app = await mount();
  try {
    await mkdir(join(app.main, "files"));
    await Promise.all(Array.from({ length: 160 }, (_, i) => writeFile(join(app.main, "files", `file-${i}.ts`), "fixture")));
    await writeFile(join(app.main, ".gitignore"), "ignored.ts\n"); await writeFile(join(app.main, "ignored.ts"), "ignore");

    expectOk(await app.index.refresh());
    const changes = app.changes();
    for (let i = 0; i < 50; i++) expect(app.paths("file-159")).toEqual(["files/file-159.ts"]);

    expect(app.changes()).toBe(changes); expect(app.paths("ignored")).toEqual([]);
    const all = app.index.read(""); if (!all) throw new Error("Index was not initialized");
    expect(expectOk(all).truncated).toBe(true); expect(app.unexpected).toEqual([]);
  } finally { await app.cleanup(); }
});

test("파일 감시는 추가·삭제·이름 변경·디렉터리 이동을 열린 인덱스에 반영한다", async () => {
  // 실제 운영체제 이벤트를 사용하되 UI나 사용자 저장소는 건드리지 않는다.
  const app = await mount();
  try {
    expectOk(await app.index.refresh());

    // 새 경로가 생기면 목록에 나타나고 이름과 디렉터리가 바뀌면 이전 경로는 사라진다.
    await mkdir(join(app.main, "before")); await writeFile(join(app.main, "before", "one.ts"), "one");
    await app.until(() => app.paths("one.ts").includes("before/one.ts"), "create");
    await rename(join(app.main, "before", "one.ts"), join(app.main, "before", "two.ts"));
    await app.until(() => app.paths("two.ts").includes("before/two.ts") && !app.paths("one.ts").length, "rename file");
    await rename(join(app.main, "before"), join(app.main, "after"));
    await app.until(() => app.paths("two.ts").includes("after/two.ts") && !app.paths("before/").length, "rename directory");
    await rename(join(app.main, "after", "two.ts"), join(app.feature, "two.ts"));
    await app.until(() => !app.paths("two.ts").length, "move out");
    await rename(join(app.feature, "two.ts"), join(app.main, "returned.ts"));
    await app.until(() => app.paths("returned.ts").includes("returned.ts"), "move in");
    await unlink(join(app.main, "returned.ts")); await app.until(() => !app.paths("returned.ts").length, "delete");

    expect(app.paths("workspace.txt")).toEqual(["workspace.txt"]); expect(app.unexpected).toEqual([]);
  } finally { await app.cleanup(); }
}, 20000);

test("ignore와 Git index 변경은 재동기화하고 tracked ignored 파일은 유지한다", async () => {
  // Git의 기존 tracked/ignore 정책을 직접 탐색의 단순 제외 규칙으로 바꾸지 않는다.
  const app = await mount();
  try {
    await writeFile(join(app.main, "candidate.ts"), "candidate"); expectOk(await app.index.refresh());

    // ignore 추가는 후보를 제거하지만 강제 추적된 파일은 다시 나타나야 한다.
    await writeFile(join(app.main, ".gitignore"), "candidate.ts\n");
    await app.until(() => !app.paths("candidate.ts").length);
    await app.git(app.main, ["-c", "core.fsmonitor=false", "add", "-f", "candidate.ts"]);
    await app.until(() => app.paths("candidate.ts").includes("candidate.ts"));

    expect(app.unexpected).toEqual([]);
  } finally { await app.cleanup(); }
});

test("포함된 Git 설정과 심볼릭 링크 대상의 excludes 변경도 재동기화한다", async () => {
  // 사용자 전역 설정을 수정하지 않고 별도 include 파일과 링크로 같은 경계를 검증한다.
  const app = await mount();
  try {
    const settings = join(app.directory, "included.gitconfig"), target = join(app.directory, "actual.ignore"), link = join(app.directory, "linked.ignore");
    await writeFile(join(app.main, "conditional.ts"), "file"); await writeFile(target, ""); await symlink(target, link);
    await writeFile(settings, `[core]\n\texcludesFile = ${JSON.stringify(link)}\n`);
    await app.git(app.main, ["config", "include.path", settings]); expectOk(await app.index.refresh());
    expect(app.paths("conditional.ts")).toEqual(["conditional.ts"]);

    // 링크 이름이 그대로여도 실제 대상 파일의 변경을 감지한다.
    await writeFile(target, "conditional.ts\n"); await app.until(() => !app.paths("conditional.ts").length, "linked excludes");
    await writeFile(settings, "[core]\n\texcludesFile = /dev/null\n");
    await app.until(() => app.paths("conditional.ts").includes("conditional.ts"), "included config");

    expect(app.unexpected).toEqual([]);
  } finally { await app.cleanup(); }
});

test("초기 스캔 중 들어온 재동기화 요청은 버리지 않고 다음 스캔에 반영한다", async () => {
  // 초기 파일 목록을 얻은 직후 변경이 생겨도 완료 직전에 놓치면 안 된다.
  const app = await mount(), scanned = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = discovery.listCompletionFiles; let calls = 0;
  const scan = spyOn(discovery, "listCompletionFiles").mockImplementation(async (cwd, signal) => {
    const result = await original(cwd, signal);
    if (++calls === 1) { scanned.resolve(); await release.promise; }
    return result;
  });
  try {
    const initial = app.index.refresh(); await scanned.promise;

    await writeFile(join(app.main, "during-startup.ts"), "new");
    const reload = app.index.refresh(); release.resolve();
    expectOk(await initial); expectOk(await reload);

    expect(app.paths("during-startup")).toEqual(["during-startup.ts"]); expect(calls).toBeGreaterThanOrEqual(2);
    expect(app.unexpected).toEqual([]);
  } finally { release.resolve(); scan.mockRestore(); await app.cleanup(); }
});

test("감시 오류는 실패로 알리고 감시 재연결과 전체 스캔으로 자동 복구한다", async () => {
  // OS 경계에서 오류를 주입하되 실제 새 watcher와 Git 재동기화를 사용한다.
  const app = await mount(), watching = spyOn(fs, "watch");
  try {
    expectOk(await app.index.refresh());
    const root = watching.mock.results[0];
    if (root?.type !== "return") throw new Error("Root watcher was not installed");

    root.value.emit("error", Object.assign(new Error("Fixture watcher failure"), { code: "EIO" }));
    const failed = app.index.read(""); if (!failed) throw new Error("Watcher failure was hidden as pending");
    expect(expectError(failed).code).toBe("STORAGE_FAILED");
    await app.until(() => app.index.read("")?.ok === true, "watch recovery");

    expect(app.paths("workspace.txt")).toEqual(["workspace.txt"]);
    expect(watching.mock.calls.length).toBeGreaterThan(1); expect(app.unexpected).toEqual([]);
  } finally { watching.mockRestore(); await app.cleanup(); }
});

test("감시를 끝내면 조회를 취소로 구분하고 초기 탐색 실패를 빈 성공으로 바꾸지 않는다", async () => {
  // 잘못된 저장소와 종료된 인덱스는 정상적인 빈 검색 결과가 아니다.
  const app = await mount();
  const invalid = new CompletionFileIndex(app.directory, () => {}, error => app.unexpected.push(error));
  try {
    const failed = await invalid.refresh();
    app.index.dispose();

    expect(expectError(failed).code).toBe("GIT_QUERY_FAILED");
    const result = app.index.read("file"); if (!result) throw new Error("Closed index returned pending");
    expect(expectError(result).code).toBe("CANCELLED"); expect(app.unexpected).toEqual([]);
  } finally { invalid.dispose(); await app.cleanup(); }
});
