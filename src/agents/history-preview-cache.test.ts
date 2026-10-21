import { expect, test } from "bun:test";
import { HistoryPreviewCache } from "./history-preview-cache.ts";
import type { HistoryPreview } from "./history-preview.ts";
import { HistoryError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

const preview = (id: string, worktreeId = "tree"): HistoryPreview => ({ worktreeId, id, text: `Preview ${id}`, truncated: false });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const unexpected = (error: unknown): string => { throw error; };

test("같은 세션의 진행 중 요청을 공유하고 완료 후에는 타이머 없이 캐시를 읽는다", async () => {
  // 한 파일을 읽는 도중 여러 번 선택해도 중복 I/O가 발생하면 안 된다.
  const pending = Promise.withResolvers<Result<HistoryPreview, HistoryError>>(); let calls = 0, changed = 0;
  const cache = new HistoryPreviewCache(async () => { calls++; return pending.promise; }, () => { changed++; }, unexpected);
  try {
    cache.select("tree", "a"); cache.select("tree", "a"); await flush();
    expect(calls).toBe(1); expect(cache.read("tree", "a")?.kind).toBe("pending");
    pending.resolve(ok(preview("a"))); await flush();

    // 완료 데이터는 재방문해도 같은 세션 슬롯에서 즉시 얻는다.
    expect(cache.select("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
    expect(calls).toBe(1); expect(changed).toBe(1);
  } finally { cache.clear(); pending.resolve(ok(preview("a"))); await flush(); }
});

test("최대 두 개만 조회하고 대기열에는 최신 선택 하나만 남긴다", async () => {
  // 빠르게 지나가는 세션을 FIFO로 모두 읽지 않아야 한다.
  const requests: string[] = [], pending = new Map<string, ReturnType<typeof Promise.withResolvers<Result<HistoryPreview, HistoryError>>>>();
  const cache = new HistoryPreviewCache(async (_tree, id) => {
    requests.push(id); const task = Promise.withResolvers<Result<HistoryPreview, HistoryError>>(); pending.set(id, task); return task.promise;
  }, () => {}, unexpected);
  try {
    for (const id of ["a", "b", "c", "d"]) cache.select("tree", id);
    await flush(); expect(requests).toEqual(["a", "b"]); expect(cache.read("tree", "c")).toBeUndefined();
    pending.get("a")!.resolve(ok(preview("a"))); await flush();

    // 슬롯이 생기면 버려진 C 대신 현재 선택 D를 조회한다.
    expect(requests).toEqual(["a", "b", "d"]); expect(cache.read("tree", "b")?.kind).toBe("pending");
    pending.get("d")!.resolve(ok(preview("d"))); await flush();
    pending.get("b")!.resolve(ok(preview("b"))); await flush();
    expect(cache.read("tree", "d")).toEqual({ kind: "ready", value: preview("d") });
    expect(cache.select("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
  } finally { cache.clear(); for (const [id, task] of pending) task.resolve(ok(preview(id))); await flush(); }
});

test("정리 후 같은 ID를 다시 조회해도 이전 응답이 새 캐시를 덮지 않는다", async () => {
  // 닫기/새로고침 경계는 ID가 같더라도 다른 캐시 세대다.
  const old = Promise.withResolvers<Result<HistoryPreview, HistoryError>>(); const signals: AbortSignal[] = []; let calls = 0;
  const cache = new HistoryPreviewCache(async (_tree, id, signal) => {
    signals.push(signal); return ++calls === 1 ? old.promise : ok({ ...preview(id), text: "Fresh" });
  }, () => {}, unexpected);
  try {
    cache.select("tree", "a"); await flush(); cache.clear(); cache.select("tree", "a"); await flush();
    expect(signals[0]!.aborted).toBe(true);
    old.resolve(ok({ ...preview("a"), text: "Stale" })); await flush();
    expect(cache.read("tree", "a")).toEqual({ kind: "ready", value: { ...preview("a"), text: "Fresh" } });
  } finally { cache.clear(); old.resolve(ok(preview("a"))); await flush(); }
});

test("같은 saved ID라도 워크트리가 다르면 다른 캐시 슬롯을 사용하고 오류를 숨기지 않는다", async () => {
  // ID만으로 전역 캐싱하면 다른 워크트리의 결과나 실패를 재사용할 수 있다.
  const failure = new HistoryError("HISTORY_UNAVAILABLE", "Deleted saved conversation"); let calls = 0;
  const cache = new HistoryPreviewCache(async (tree, id) => { calls++; return tree === "gone" ? err(failure) : ok(preview(id, tree)); }, () => {}, unexpected);
  try {
    cache.select("tree", "a"); await flush(); cache.select("gone", "a"); await flush();
    expect(cache.read("tree", "a")).toEqual({ kind: "ready", value: preview("a") });
    expect(cache.read("gone", "a")).toEqual({ kind: "error", error: failure }); expect(calls).toBe(2);
  } finally { cache.clear(); }
});

test("본문 용량이 상한에 이르면 오래된 결과를 비우되 현재 선택과 진행 중 요청은 보존한다", async () => {
  // 테스트 데이터는 실제 heap 대신 캐시가 제한하는 직렬화 텍스트 예산을 넘긴다.
  const text = "x".repeat(3 * 1024 * 1024);
  const cache = new HistoryPreviewCache(async (tree, id) => ok({ ...preview(id, tree), text }), () => {}, unexpected);
  try {
    for (const id of ["a", "b", "c"]) { cache.select("tree", id); await flush(); }
    expect(cache.read("tree", "a")).toBeUndefined(); expect(cache.read("tree", "b")?.kind).toBe("ready");
    expect(cache.read("tree", "c")?.kind).toBe("ready");
  } finally { cache.clear(); }
});

test("예상하지 못한 실패는 원래 오류를 UI 경계에 전달하고 일반 조회 오류로 분류하지 않는다", async () => {
  // 프로그래밍 오류는 로그 경계에서 관찰할 수 있어야 하며 정상 빈 Preview가 아니다.
  const error = new TypeError("Broken loader"), reported: unknown[] = [];
  const cache = new HistoryPreviewCache(async () => { throw error; }, () => {}, failure => { reported.push(failure); return "Unexpected preview failure"; });
  try {
    cache.select("tree", "a"); await flush();
    expect(reported).toEqual([error]); expect(cache.read("tree", "a")).toEqual({ kind: "unexpected", message: "Unexpected preview failure" });
  } finally { cache.clear(); }
});
