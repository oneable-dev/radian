import { expect, test } from "bun:test";
import { piSubagentsFromWidget } from "./pi-subagent-status.ts";
import { expectError, expectOk } from "../testing/results.ts";

const widget = (runs: unknown[]) => ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 10000, runs })];

test("Pi async snapshots expose individual children without counting workflow wrappers or host gates as agents", () => {
  // A workflow groups real children and a host gate, but is not itself another agent.
  const content = widget([{ id: "workflow", kind: "workflow", label: "Workflow", state: "running", children: [
    { id: "writer", kind: "step", label: "Implement status", state: "running", startedAt: 1000 },
    { id: "reviewer", kind: "step", label: "Review status", state: "complete", startedAt: 2000, endedAt: 6000 },
    { id: "gate", kind: "host-step", label: "Typecheck", state: "running" },
  ] }]);

  const children = expectOk(piSubagentsFromWidget(content));

  // Observed children carry elapsed time, never invented task prompts or ownership.
  expect(children.map(child => [child.name, child.status, child.source])).toEqual([
    ["Implement status", "working", "pi"], ["Review status", "complete", "pi"],
  ]);
  expect(children.map(child => child.runTiming?.elapsedMs)).toEqual([9000, 4000]);
  expect(children.every(child => child.request === undefined)).toBe(true);
  expect(expectOk(piSubagentsFromWidget(content)).map(child => child.id)).toEqual(children.map(child => child.id));
});

test("A real agent with only host-gate children remains visible without turning the gate into another agent", () => {
  // A host gate has no concrete child step that could stand in for its owning agent.
  const content = widget([{ id: "review", kind: "subagent", label: "reviewer", state: "running", children: [
    { id: "gate", kind: "host-step", label: "Typecheck", state: "running" },
  ] }]);

  const children = expectOk(piSubagentsFromWidget(content));

  expect(children).toHaveLength(1); expect(children[0]?.name).toBe("reviewer"); expect(children[0]?.status).toBe("working");
});

test.each([
  ["queued", null, "queued"], ["paused", null, "paused"], ["stopped", null, "stopped"],
  ["rejected", "failure", "rejected"], ["partial", "failure", "partial"], ["failed", "failure", undefined],
] as const)("Pi state %s retains its outcome instead of being reported as successful completion", (state, status, phase) => {
  // Non-success outcomes must not become either working or complete in the shared status model.
  const content = widget([{ id: "run", kind: "subagent", label: "reviewer", state }]);

  const children = expectOk(piSubagentsFromWidget(content));

  expect(children).toHaveLength(1); expect(children[0]?.status).toBe(status); expect(children[0]?.phase).toBe(phase);
  expect(children[0]?.runTiming).toBeUndefined();
});

test("Single-run projections suppress duplicate parent rows and widget retraction clears observed children", () => {
  // A single run can publish both its wrapper and its one concrete execution step.
  const node = { id: "step:0", kind: "step", label: "reviewer", state: "running" };

  const children = expectOk(piSubagentsFromWidget(widget([{ id: "run", kind: "subagent", label: "reviewer", state: "running", children: [node, node] }])));

  expect(children).toHaveLength(1); expect(expectOk(piSubagentsFromWidget(undefined))).toEqual([]);
  expect(expectOk(piSubagentsFromWidget(widget([{ id: "planned", kind: "workflow", label: "Workflow", state: "queued" }])))).toEqual([]);
});

test.each([
  ["PI_SUBAGENT_ASYNC_JSON:{"], ["ordinary terminal text"],
  ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 2, generatedAt: 10000, runs: [] })],
  widget([{ id: "bad", kind: "step", label: "bad", state: "running", children: {} }]),
  widget([{ id: "x".repeat(5000), kind: "step", label: "bad", state: "running" }]),
].map(content => ({ content })))("Malformed or unsupported Pi status payloads fail with a stable protocol code", ({ content }) => {
  // Widget payloads are an external protocol boundary rather than trusted TypeScript values.
  const result = piSubagentsFromWidget(content);

  expect(expectError(result).code).toBe("PROTOCOL_ERROR");
});
