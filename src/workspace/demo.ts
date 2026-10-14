import type { Repository } from "./model.ts";

export function demoWorkspace(): Repository[] {
  return [{
    id: "demo:radian", name: "radian [demo]", worktrees: [
      {
        id: "demo:main", path: "/demo/radian", name: "radian", branch: "main", sessions: [
          { id: "a1", name: "Workspace layout", status: "complete", subagents: [{ id: "child1", name: "UI review", status: "working" }] },
          { id: "a2", name: "Session navigation", status: "complete", subagents: [] },
          { id: "a3", name: "Empty states", status: "failure", subagents: [] },
        ],
      },
      {
        id: "demo:feature", path: "/demo/radian-ui", name: "radian-ui", branch: "feature/workspace", sessions: [
          { id: "b1", name: "Sidebar prototype", status: null, subagents: [] },
        ],
      },
      { id: "demo:empty", path: "/demo/radian-empty", name: "radian-empty", branch: "feature/empty", sessions: [] },
    ],
  }];
}
