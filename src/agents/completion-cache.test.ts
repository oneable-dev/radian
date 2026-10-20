import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompletionCache } from "./completion-cache.ts";
import type { CompletionCatalog } from "./completion.ts";
import { CapabilityError } from "../errors.ts";
import { err, ok } from "../result.ts";
import { createWorktreeFixture } from "../testing/worktree-fixture.ts";
import { expectError, expectOk } from "../testing/results.ts";

const catalog = (revision = 0): CompletionCatalog => ({ conversationId: "conversation", revision, items: [
  ...Array.from({ length: 150 }, (_, i) => ({ kind: "command" as const, value: `command-${i}`, description: "Command" })),
  { kind: "skill", value: "skill:review-code", description: "Review code" },
] });

test("초기 준비 후 명령·스킬·파일 검색과 화면 갱신은 같은 목록을 재사용한다", async () => {
  // 카탈로그는 100개를 넘고 파일 목록도 실제 선택한 워크트리에서 한 번 준비한다.
  const fixture = await createWorktreeFixture(), unexpected: unknown[] = [];
  let requests = 0;
  const cache = new CompletionCache(async () => { requests++; return ok(catalog()); }, () => "instance/conversation/0", error => unexpected.push(error));
  const provider = cache.provider, signal = new AbortController().signal;
  try {
    await writeFile(join(fixture.main, "last-file.ts"), "file");
    provider.prepare?.("session", fixture.main);
    expectOk(await provider("session", { kind: "command", query: "command-149" }, signal));
    expectOk(await provider("session", { kind: "file", query: "last-file" }, signal));

    // 타이핑과 같은 세션의 재선택은 서버에 카탈로그를 다시 요청하지 않는다.
    for (let i = 0; i < 50; i++) {
      provider.prepare?.("session", fixture.main);
      expect(expectOk(provider.read!("session", { kind: "command", query: "command-149" })!).items[0]?.value).toBe("command-149");
      expect(expectOk(provider.read!("session", { kind: "skill", query: "review" })!).items[0]?.value).toBe("review-code");
      expect(expectOk(provider.read!("session", { kind: "file", query: "last-file" })!).items[0]?.value).toBe("last-file.ts");
    }

    expect(requests).toBe(1); expect(unexpected).toEqual([]);
    expect(expectError(await provider("session", { kind: "command", query: "" }, AbortSignal.abort())).code).toBe("CANCELLED");
    expect(expectOk(provider.read!("session", { kind: "command", query: "review" })!).items).toEqual([]);
  } finally { cache.dispose(); await fixture.cleanup(); }
});

test("리로드 revision이나 런타임·대화 identity가 바뀔 때만 카탈로그를 다시 준비한다", async () => {
  // 화면 수명이 아니라 실제 리소스 identity가 캐시의 유효성을 결정한다.
  const fixture = await createWorktreeFixture(); let identity = "instance/conversation/0", revision = 0, requests = 0;
  const cache = new CompletionCache(async () => { requests++; return ok(catalog(revision)); }, () => identity, error => { throw error; });
  try {
    cache.provider.prepare?.("session", fixture.main);
    expectOk(await cache.provider("session", { kind: "skill", query: "review" }, new AbortController().signal));

    // 같은 UI 탭이라도 리소스나 서버가 교체되면 이전 목록을 새 목록으로 갱신한다.
    revision++; identity = "instance/conversation/1";
    expectOk(await cache.refresh("session")); expect(requests).toBe(2);
    identity = "replacement/conversation/1"; cache.provider.prepare?.("session", fixture.main);
    expectOk(await cache.provider("session", { kind: "command", query: "command-149" }, new AbortController().signal));

    expect(requests).toBe(3);
  } finally { cache.dispose(); await fixture.cleanup(); }
});

test("세션을 교체한 뒤 도착한 이전 카탈로그는 새 목록을 덮지 않는다", async () => {
  // 오래된 요청이 취소를 무시해도 identity와 소유 엔트리 검사가 응답을 차단한다.
  const fixture = await createWorktreeFixture(); let identity = "first";
  const first = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>(), second = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>();
  const cache = new CompletionCache(async () => identity === "first" ? first.promise : second.promise, () => identity, error => { throw error; });
  try {
    cache.provider.prepare?.("session", fixture.main); await Promise.resolve();
    const old = cache.provider("session", { kind: "command", query: "" }, new AbortController().signal);

    // 새 대화가 먼저 준비된 후 이전 응답을 늦게 반환한다.
    identity = "second"; cache.provider.prepare?.("session", fixture.main); await Promise.resolve();
    second.resolve(ok({ conversationId: "second", revision: 0, items: [{ kind: "command", value: "fresh", description: "Fresh" }] }));
    first.resolve(ok({ conversationId: "first", revision: 0, items: [{ kind: "command", value: "stale", description: "Stale" }] }));
    const fresh = expectOk(await cache.provider("session", { kind: "command", query: "" }, new AbortController().signal));

    expect(expectError(await old).code).toBe("CANCELLED"); expect(fresh.items.map(item => item.value)).toEqual(["fresh"]);
  } finally { first.resolve(ok(catalog())); second.resolve(ok(catalog())); cache.dispose(); await fixture.cleanup(); }
});

test("조회 취소는 공유 초기화를 중단하지 않으며 실패는 빈 성공으로 바뀌지 않는다", async () => {
  // Esc로 한 검색을 닫아도 앱이 시작한 공용 카탈로그 준비는 계속되어야 한다.
  const fixture = await createWorktreeFixture(), ready = Promise.withResolvers<ReturnType<typeof ok<CompletionCatalog>>>();
  let fail = false, identity = "first", requests = 0;
  const cache = new CompletionCache(async () => { requests++; return fail ? err(new CapabilityError("Catalog unavailable")) : ready.promise; }, () => identity, error => { throw error; });
  try {
    cache.provider.prepare?.("session", fixture.main);
    const abort = new AbortController(), query = cache.provider("session", { kind: "command", query: "" }, abort.signal);
    abort.abort(); expect(expectError(await query).code).toBe("CANCELLED");

    ready.resolve(ok(catalog()));
    expectOk(await cache.provider("session", { kind: "command", query: "command-149" }, new AbortController().signal));
    fail = true; identity = "second"; cache.provider.prepare?.("session", fixture.main);
    const failed = await cache.provider("session", { kind: "command", query: "" }, new AbortController().signal);

    expect(expectError(failed).code).toBe("UNSUPPORTED_CAPABILITY"); expect(requests).toBe(2);
    cache.provider.retain?.(new Set());
    expect(expectError(await cache.provider("session", { kind: "file", query: "" }, new AbortController().signal)).code).toBe("SESSION_NOT_OPEN");
  } finally { ready.resolve(ok(catalog())); cache.dispose(); await fixture.cleanup(); }
});
