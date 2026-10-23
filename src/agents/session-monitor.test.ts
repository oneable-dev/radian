import { expect, test } from "bun:test";
import { monitoredSessions } from "./session-monitor.ts";
import type { Repository } from "../workspace/model.ts";
import type { OpenSession } from "./model.ts";

const session = (id: string, status: OpenSession["status"] = "complete"): OpenSession => ({ id, name: id, status, subagents: [] });
const repositories = (sessions: OpenSession[]): Repository[] => [{ id: "repo", name: "Radian", worktrees: [{ id: "tree", path: "/repo", name: "feature-auth", branch: "fix/login", sessions }] }];

test("Monitors collect active and unread sessions across repositories and prioritize unread results", () => {
  // Failed children must not hide sessions while other child runs remain active.
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

test("Monitor search matches words across requests and workspace fields without fuzzy matching", () => {
  // A query may combine contiguous substrings from different summary fields.
  const input = repositories([{ ...session("opaque-id", "working"), request: { text: "Fix authentication", images: 0, files: 0 } }]);

  const items = monitoredSessions(input, "  ＡＵＴＨ rad feature  ");

  // Filtering must neither match scattered letters nor alter the source sessions.
  expect(items.map(item => item.session.id)).toEqual(["opaque-id"]);
  expect(monitoredSessions(input, "fxauth rad ftr")).toEqual([]);
  expect(monitoredSessions(input, "unrelated")).toEqual([]);
  expect(input[0]?.worktrees[0]?.sessions).toHaveLength(1);
});
