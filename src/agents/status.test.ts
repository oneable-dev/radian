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
  test(`Main agent ${main ?? "unreported"} and subagents ${JSON.stringify(children)} yield session status ${expected ?? "unreported"}`, () => {
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
