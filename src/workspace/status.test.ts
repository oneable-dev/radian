import { expect, test } from "bun:test";
import type { AgentStatus, OpenSession } from "./model.ts";
import { sessionStatus } from "./status.ts";

const cases: [AgentStatus | null, (AgentStatus | null)[], AgentStatus | null][] = [
  ["complete", [], "complete"],
  ["working", [], "working"],
  ["failure", [], "failure"],
  [null, [], null],
  ["complete", ["working"], "working"],
  ["working", ["complete"], "working"],
  ["complete", ["complete", "complete"], "complete"],
  ["complete", ["failure", "working"], "failure"],
  ["working", ["failure"], "failure"],
  ["failure", ["working"], "failure"],
  [null, ["complete"], null],
  ["complete", [null], null],
  [null, ["working"], "working"],
  [null, ["failure"], "failure"],
];

for (const [main, children, expected] of cases) {
  test(`주agent ${main ?? "미보고"}와 subagent ${JSON.stringify(children)}의 세션 상태는 ${expected ?? "미보고"}이다`, () => {
    // Normalized snapshots model owned agents without creating any runtime.
    const session: OpenSession = {
      id: "session", name: "Session", status: main,
      subagents: children.map((status, index) => ({ id: `child-${index}`, name: "Subagent", status })),
    };

    // Aggregate only the current states supplied by the host.
    const result = sessionStatus(session);

    // Failure wins; working wins over completion; missing data never implies success.
    expect(result).toBe(expected);
  });
}
