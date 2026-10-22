import { expect, test } from "bun:test";
import { monitoredSessions } from "./session-monitor.ts";
import type { Repository } from "../workspace/model.ts";
import type { OpenSession } from "./model.ts";

const session = (id: string, status: OpenSession["status"] = "complete"): OpenSession => ({ id, name: id, status, subagents: [] });
const repositories = (sessions: OpenSession[]): Repository[] => [{ id: "repo", name: "Radian", worktrees: [{ id: "tree", path: "/repo", name: "feature-auth", branch: "fix/login", sessions }] }];

test("모니터는 모든 저장소의 실행 중·미확인 세션만 모으고 미확인을 먼저 표시한다", () => {
  // 실패한 하위 에이전트가 있어도 다른 하위 실행이 진행 중이면 세션을 놓치지 않는다.
  const active = { ...session("active"), subagents: [{ id: "bad", name: "bad", status: "failure" as const }, { id: "live", name: "live", status: "working" as const }] };
  const unread = { ...session("unread"), attention: { id: "result", outcome: "unfinished" as const, completedAt: 1 }, request: { text: "Fix authentication", images: 0, files: 0 } };
  const input = repositories([session("read"), active, unread, session("cancelled", null)]);
  input.push({ id: "other", name: "Backend", worktrees: [{ id: "other-tree", path: "/backend", name: "main", branch: "main", sessions: [session("background", "working")] }] });

  const items = monitoredSessions(input);

  expect(items.map(item => item.session.id)).toEqual(["unread", "active", "background"]);
  expect(items[0]?.title).toBe("Fix authentication");
  expect(items[1]?.working).toBe(true);
  expect(items[2]?.repository).toBe("Backend");
});

test("모니터 검색은 요청과 워크스페이스 필드에 단어별 포함 검색을 적용하고 퍼지 매칭을 거부한다", () => {
  // A query may combine contiguous substrings from different summary fields.
  const input = repositories([{ ...session("opaque-id", "working"), request: { text: "Fix authentication", images: 0, files: 0 } }]);

  const items = monitoredSessions(input, "  ＡＵＴＨ rad feature  ");

  // Filtering must neither match scattered letters nor alter the source sessions.
  expect(items.map(item => item.session.id)).toEqual(["opaque-id"]);
  expect(monitoredSessions(input, "fxauth rad ftr")).toEqual([]);
  expect(monitoredSessions(input, "unrelated")).toEqual([]);
  expect(input[0]?.worktrees[0]?.sessions).toHaveLength(1);
});
