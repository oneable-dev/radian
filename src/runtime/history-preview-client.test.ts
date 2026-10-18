import { expect, spyOn, test } from "bun:test";
import { RuntimeClient } from "./client.ts";
import { emptyPreferences, protocolVersion, type RuntimeSnapshot } from "./protocol.ts";
import { runtimePaths } from "./storage.ts";
import { expectError, expectOk } from "../testing/results.ts";

const paths = runtimePaths("/fixture/.git", true, "/tmp/radian-history-preview-client");
const snapshot = (preview = true): RuntimeSnapshot => ({ version: protocolVersion, pid: process.pid, instance: "first", repositoryId: "/fixture/.git", mode: "offline",
  repositories: [], details: {}, closingCount: 0, preferences: structuredClone(emptyPreferences), notice: "", capabilities: preview ? ["history", "history-preview"] : ["history"] });
function stub(implementation: (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

test("이전 서비스는 미리보기 부족을 명시하고 조회·재시작·모델 요청을 보내지 않는다", async () => {
  const fetchMock = stub(async () => { throw new Error("No requests allowed"); }), client = new RuntimeClient(paths, snapshot(false));
  try {
    const result = expectError(await client.previewHistory("tree", "saved"));
    expect(result.code).toBe("UNSUPPORTED_CAPABILITY"); expect(result.message).toContain("Search and Open remain available"); expect(fetchMock).not.toHaveBeenCalled();
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("미리보기는 instance-fenced GET이고 잘못된 신원·형식은 protocol 오류로 거절한다", async () => {
  const valid = { id: "saved", worktreeId: "문서/a b", text: "You\nQuestion", truncated: false,
    sections: [{ id: "q", kind: "user", title: "You", text: "Question", status: "complete" }] };
  let response: unknown = valid;
  const requests: string[] = [];
  const fetchMock = stub(async (input, options) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    expect(url.searchParams.get("worktreeId")).toBe("문서/a b"); expect(url.searchParams.get("savedId")).toBe("saved");
    expect(new Headers(options?.headers).get("X-Radian-Instance")).toBe("first");
    expect(options?.method ?? "GET").toBe("GET"); return Response.json(response);
  });
  const client = new RuntimeClient(paths, snapshot());
  try {
    const preview = expectOk(await client.previewHistory("문서/a b", "saved"));
    expect(preview.text).toBe("You\nQuestion"); expect(preview.sections?.[0]).toMatchObject({ kind: "user", text: "Question" });
    response = { id: "different", worktreeId: "문서/a b", text: "Wrong conversation", truncated: false };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe("PROTOCOL_ERROR");
    response = { text: "Missing identity" }; expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe("PROTOCOL_ERROR");
    response = { ...valid, sections: [{ ...valid.sections[0], kind: "unsupported" }] };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe("PROTOCOL_ERROR");
    response = { ...valid, sections: Array.from({ length: 7 }, (_, i) => ({ ...valid.sections[0], id: `q${i}` })) };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe("PROTOCOL_ERROR");
    response = { ...valid, sections: [{ ...valid.sections[0], text: "x".repeat(8193) }] };
    expect(expectError(await client.previewHistory("문서/a b", "saved")).code).toBe("PROTOCOL_ERROR");
    response = { id: "saved", worktreeId: "문서/a b", text: "Legacy preview", truncated: false };
    expect(expectOk(await client.previewHistory("문서/a b", "saved")).sections).toBeUndefined();
    expect(requests).toEqual(Array(7).fill("/history/preview"));
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("구조화한 명령과 timeout은 미리보기 IPC로 보존하고 잘못된 타입·제한은 거절한다", async () => {
  // 기존 필드를 그대로 둔 채 새 표시 메타데이터를 선택적으로 전달한다.
  const section = { id: "tool", kind: "tool", title: "bash", text: "Arguments:\n{}\n\nResult:\nDone", status: "complete", command: "printf done", timeoutSeconds: 120 };
  let returned: unknown = section;
  const fetchMock = stub(async () => Response.json({ id: "saved", worktreeId: "tree", text: "", truncated: false, sections: [returned] }));
  const client = new RuntimeClient(paths, snapshot());
  try {
    const preview = expectOk(await client.previewHistory("tree", "saved"));
    expect(preview.sections?.[0]).toMatchObject({ command: "printf done", timeoutSeconds: 120 });
    // 수치의 단위와 명령 미리보기의 크기를 보장하지 못하는 응답은 조용히 표시하지 않는다.
    for (const invalid of [{ timeoutSeconds: 0 }, { timeoutSeconds: -1 }, { timeoutSeconds: "120" }, { command: "x".repeat(4097) }]) {
      returned = { ...section, ...invalid };
      expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
    }
    const { command: _command, timeoutSeconds: _timeout, ...legacy } = section;
    returned = legacy; expect(expectOk(await client.previewHistory("tree", "saved")).sections?.[0]?.command).toBeUndefined();
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("요청 완료 정보는 미리보기 IPC로 보존하며 미완료·잘못된 시각은 거절한다", async () => {
  const completion = { startedAt: 1000000, completedAt: 1090000, durationMs: 90000, outcome: "complete" as const };
  let returned: unknown = completion;
  const fetchMock = stub(async () => Response.json({ id: "saved", worktreeId: "tree", text: "", truncated: false,
    sections: [{ id: "a", kind: "assistant", title: "Agent", text: "Answer", status: "complete", completion: returned }] }));
  const client = new RuntimeClient(paths, snapshot());
  try {
    expect(expectOk(await client.previewHistory("tree", "saved")).sections?.[0]?.completion).toEqual(completion);
    for (const invalid of [{ durationMs: -1 }, { completedAt: 8640000000000001 }, { outcome: "working" }, { warning: "x".repeat(513) }]) {
      returned = { ...completion, ...invalid };
      expect(expectError(await client.previewHistory("tree", "saved")).code).toBe("PROTOCOL_ERROR");
    }
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("닫힌 팝업의 목록 요청도 CANCELLED로 정리하고 다른 워크트리 목록을 거절한다", async () => {
  let pending = true;
  const fetchMock = stub(async (_input, options) => pending ? new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  }) : Response.json([{ id: "saved", worktreeId: "other", title: "Wrong scope", modified: "2026-10-14", messageCount: 1, openSessionId: null, unavailableReason: null }]));
  const client = new RuntimeClient(paths, snapshot()), controller = new AbortController();
  try {
    const read = client.listHistory("tree", controller.signal); controller.abort();
    expect(expectError(await read).code).toBe("CANCELLED");
    pending = false; expect(expectError(await client.listHistory("tree")).code).toBe("PROTOCOL_ERROR");
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});

test("취소된 미리보기는 빈 성공이나 예외 대신 CANCELLED로 정리한다", async () => {
  const fetchMock = stub(async (_input, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  }));
  const client = new RuntimeClient(paths, snapshot()), controller = new AbortController();
  try {
    const pending = client.previewHistory("tree", "saved", controller.signal); controller.abort();
    expect(expectError(await pending).code).toBe("CANCELLED");
    const count = fetchMock.mock.calls.length;
    expect(expectError(await client.previewHistory("tree", "saved", controller.signal)).code).toBe("CANCELLED"); expect(fetchMock).toHaveBeenCalledTimes(count);
  } finally { await client.disconnect(); fetchMock.mockRestore(); }
});
