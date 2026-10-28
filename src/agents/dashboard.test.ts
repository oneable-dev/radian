import { expect, test } from "bun:test";
import {
  DashboardAccumulator,
  dashboardDate,
  emptyDashboard,
  mergeDashboards,
} from "./dashboard.ts";
import { runCompletionEntryType } from "./run-completion.ts";
import { expectError, expectOk } from "../testing/results.ts";

const now = new Date(2026, 2, 22, 12).getTime();
const entry = (id: string, fields: Record<string, unknown>, timestamp = now - 1000) => ({
  id,
  parentId: null,
  timestamp: new Date(timestamp).toISOString(),
  ...fields,
});
const message = (id: string, fields: Record<string, unknown>, timestamp?: number) =>
  entry(
    id,
    { type: "message", message: { timestamp: timestamp ?? now - 1000, ...fields } },
    timestamp,
  );
const usage = {
  input: 100,
  output: 20,
  cacheRead: 80,
  cacheWrite: 10,
  reasoning: 15,
  cacheWrite1h: 5,
  totalTokens: 210,
};
const assistant = (id: string, content: unknown[] = []) =>
  message(id, { role: "assistant", provider: "test", model: "large", usage, content });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

test("Period token totals include cache but never double-count reasoning or context size", () => {
  // Summaries and cache warming consume tokens; tokensBefore is not consumption.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [
    assistant("answer"),
    entry("compact", { type: "compaction", tokensBefore: 90000, usage }),
    entry("warm", { type: "usage", provider: "test", model: "small", usage }),
  ];

  // Aggregate the three recorded categories of model usage.
  for (const value of entries) {
    expectOk(accumulator.add(value));
  }

  const result = accumulator.finish();

  // Count each component once for a total of 210 tokens.
  expect(result.totals.tokens).toBe(630);
  expect(result.daily.at(-1)?.tokens).toBe(630);
  expect(result.models).toEqual([
    { name: "test/large", value: 420 },
    { name: "test/small", value: 210 },
  ]);
});

test("Runs aggregate by completion time and retain actual counts and duration for errors and interruptions", () => {
  // Prepare completion metadata so prompts and tool calls cannot inflate run counts.
  const accumulator = new DashboardAccumulator(1, "/repo", now);
  for (const [index, outcome] of ["complete", "error", "cancelled"].entries()) {
    expectOk(
      accumulator.add(
        entry(`run-${index}`, {
          type: "custom",
          customType: runCompletionEntryType,
          data: { startedAt: now - 6000, completedAt: now - 1000, durationMs: 5000, outcome },
        }),
      ),
    );
  }

  // Aggregate different outcomes on the same date.
  const result = accumulator.finish();

  // Show all three actual runs and cumulative duration regardless of success.
  expect(result.totals).toEqual({ tokens: 0, runs: 3, durationMs: 15000 });
  expect(result.daily).toEqual([
    { date: dashboardDate(now), tokens: 0, runs: 3, durationMs: 15000 },
  ]);
});

test("Explicit skill calls and successful reads aggregate while failed and ordinary SKILL.md reads are excluded", () => {
  // Skill catalogs and calls must not turn ordinary or failed reads into skill loads.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [
    message("system", {
      role: "system",
      sections: {
        skills:
          "<skill>\n<name>good-code</name>\n<description>Code</description>\n<location>/skills/good/SKILL.md</location>\n</skill>",
      },
    }),
    message("explicit", {
      role: "user",
      content: '<skill name="good-code" location="/skills/good/SKILL.md">\nInstructions\n</skill>',
    }),
    assistant("read-calls", [
      call("good", "read", { path: "/skills/good/SKILL.md" }),
      call("failed", "read", { path: "/skills/good/SKILL.md" }),
      call("ordinary", "read", { path: "/repo/SKILL.md" }),
      call("discovered", "read", { path: "/skills/review/SKILL.md" }),
    ]),
    message("good-result", {
      role: "toolResult",
      toolCallId: "good",
      content: [{ type: "text", text: "Partial known instructions" }],
      isError: false,
    }),
    message("failed-result", {
      role: "toolResult",
      toolCallId: "failed",
      content: [],
      isError: true,
    }),
    message("ordinary-result", {
      role: "toolResult",
      toolCallId: "ordinary",
      content: [{ type: "text", text: "An ordinary file" }],
      isError: false,
    }),
    message("discovered-result", {
      role: "toolResult",
      toolCallId: "discovered",
      content: [
        { type: "text", text: "---\nname: review-code\ndescription: Review\n---\nInstructions" },
      ],
      isError: false,
    }),
  ];

  // Group both invocation paths under the same skill name.
  for (const value of entries) {
    expectOk(accumulator.add(value));
  }

  const result = accumulator.finish();

  // Expose totals without distinguishing invocation sources.
  expect(result.skills).toEqual([
    { name: "good-code", value: 2 },
    { name: "review-code", value: 1 },
  ]);
});

test("MCP gateway calls do not double-count nested calls and subagent management queries are excluded", () => {
  // Observe persisted nestedCalls, not script source strings.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [
    assistant("calls", [
      call("native", "mcp__figma_remote__get_design", {}),
      call("gateway", "mcp", { tool: "mcp__atlassian__issue" }),
      call("worker", "radian_subagent", { name: "reviewer", task: "review" }),
      call("inspect", "subagent", { action: "status", agent: "reviewer" }),
      call("single", "subagent", { agent: "implementer", task: "build" }),
    ]),
    message("native-result", {
      role: "toolResult",
      toolCallId: "native",
      details: { server: "figma-remote", tool: "get_design" },
      content: [],
    }),
    message("gateway-result", {
      role: "toolResult",
      toolCallId: "gateway",
      nestedCalls: {
        complete: true,
        calls: [
          { id: "n1", name: "mcp__atlassian__issue", status: "ok" },
          { id: "n2", name: "mcp__atlassian__search", status: "error" },
        ],
      },
      content: [],
    }),
  ];

  // Record two nested tool calls and one direct call.
  for (const value of entries) {
    expectOk(accumulator.add(value));
  }

  const result = accumulator.finish();

  // Server calls are distinct from tokens; management queries are not runs.
  expect(result.mcp).toEqual([
    { name: "atlassian", value: 2 },
    { name: "figma-remote", value: 1 },
  ]);
  expect(result.subagents).toEqual([
    { name: "implementer", value: 1 },
    { name: "reviewer", value: 1 },
  ]);
});

test("Forked common history counts once while new entries add usage", () => {
  // SDK forks copy historical entry IDs and timestamps unchanged.
  const original = new DashboardAccumulator(7, "/repo", now);
  expectOk(original.add(assistant("shared")));

  const fork = new DashboardAccumulator(7, "/repo", now, original.identities);

  // Forks retain context but only new responses increase token usage.
  expectOk(fork.add(assistant("shared")));
  expectOk(fork.add(assistant("new")));

  const result = mergeDashboards([original.finish(), fork.finish()], 7, now);

  // Context copying is not new model consumption.
  expect(result.totals.tokens).toBe(420);
  expect(result.models).toEqual([{ name: "test/large", value: 420 }]);
});

test("Exclude out-of-range and future records while retaining inactive dates in graphs", () => {
  // Prepare records before today's midnight and after the current time.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const accumulator = new DashboardAccumulator(1, "/repo", now);
  const fields = { role: "assistant", provider: "test", model: "large", usage, content: [] };

  // Apply the correct inclusivity at both range boundaries.
  expectOk(accumulator.add(message("old", fields, start.getTime() - 1)));
  expectOk(accumulator.add(message("boundary", fields, start.getTime())));
  expectOk(accumulator.add(message("future", fields, now + 1)));

  // Preserve empty daily buckets and include only usage within the range.
  expect(accumulator.finish().totals.tokens).toBe(210);
  expect(emptyDashboard(30, now).daily).toHaveLength(30);
  expect(emptyDashboard(7, now).totals).toEqual({ tokens: 0, runs: 0, durationMs: 0 });
});

test("Saved workflow children aggregate by actual agent and warn about missing metadata", () => {
  // Never infer agent calls by parsing execution script strings.
  const accumulator = new DashboardAccumulator(7, "/repo", now);
  const entries = [
    assistant("workflow-calls", [
      call("workflow", "subagent", { workflowScript: "opaque script" }),
      call("opaque", "subagent", { workflow: "named" }),
      call("script", "mcpScript", { code: "opaque script" }),
    ]),
    message("workflow-result", {
      role: "toolResult",
      toolCallId: "workflow",
      details: {
        mode: "workflow",
        results: [
          { agent: "reviewer", runId: "one" },
          { agent: "reviewer", runId: "two" },
          { agent: "reviewer", runId: "one" },
          { agent: "implementer", runId: "three" },
        ],
      },
      content: [],
    }),
    message("opaque-result", {
      role: "toolResult",
      toolCallId: "opaque",
      details: {},
      content: [],
    }),
    message("script-result", { role: "toolResult", toolCallId: "script", content: [] }),
  ];

  // Count only observed child runs and deduplicate run IDs.
  for (const value of entries) {
    expectOk(accumulator.add(value));
  }

  const result = accumulator.finish();

  // Distinguish missing data from observed zero usage.
  expect(result.subagents).toEqual([
    { name: "reviewer", value: 2 },
    { name: "implementer", value: 1 },
  ]);
  expect(result.warnings).toEqual([
    "Some subagent workflows lack stored child metadata and are excluded.",
    "Some scripted MCP calls lack stored server metadata and are excluded.",
  ]);
});

test("Nested model usage stays unattributed instead of inheriting the parent model", () => {
  // Never assign the parent model identity to a separate call inside a tool.
  const accumulator = new DashboardAccumulator(7, "/repo", now);

  // Include SDK toolResult usage in total consumption.
  expectOk(
    accumulator.add(
      message("nested-usage", { role: "toolResult", toolCallId: "nested", usage, content: [] }),
    ),
  );

  const result = accumulator.finish();

  // Preserve totals without guessing model attribution.
  expect(result.totals.tokens).toBe(210);
  expect(result.models).toEqual([{ name: "Tool work (unattributed)", value: 210 }]);
});

test("Invalid usage returns stable history errors instead of becoming zero", () => {
  // Negative or missing tokens are not valid empty statistics.
  const accumulator = new DashboardAccumulator(7, "/repo", now);

  // Pass invalid persisted usage through the public aggregation boundary.
  const result = accumulator.add(
    message("bad", { role: "assistant", content: [], usage: { ...usage, input: -1 } }),
  );

  // Return explicit errors so callers can show partial-aggregation warnings.
  expect(expectError(result).code).toBe("HISTORY_CORRUPT");
});
