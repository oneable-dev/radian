import { expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PiSubagentDisplay } from "./pi-subagent-display.ts";
import { piSubagentsFromWidget } from "./pi-subagent-status.ts";
import { expectOk } from "../testing/results.ts";

const widget = (runs: unknown[]) => [
  "PI_SUBAGENT_ASYNC_JSON:" +
    JSON.stringify({
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      generatedAt: 10000,
      runs,
    }),
];
const workflow = (id: string) => ({
  id,
  kind: "workflow",
  label: "Workflow",
  state: "running",
  children: [
    {
      id: "writer",
      kind: "step",
      label: "Test implementer response",
      state: "running",
      startedAt: 1000,
    },
  ],
});

test("Workflow children use their exact agent names instead of task labels without inventing redacted inputs", () => {
  // Identical workflow keys belong to different runs and must not borrow each other's agent names.
  const events = createEventBus(),
    display = new PiSubagentDisplay(events, () => {});
  try {
    events.emit("subagent:child-status", {
      type: "subagent.child-status",
      version: 1,
      runId: "first",
      childId: "writer",
      status: "started",
      agent: "implementer",
      ts: 1000,
    });
    events.emit("subagent:child-status", {
      type: "subagent.child-status",
      version: 1,
      runId: "second",
      childId: "writer",
      status: "started",
      agent: "reviewer",
      ts: 1000,
    });

    const children = expectOk(
      piSubagentsFromWidget(widget([workflow("first"), workflow("second")]), display.lookup),
    );

    // Lifecycle labels are presentation text, not authored inputs.
    expect(children.map((child) => child.name)).toEqual(["implementer", "reviewer"]);
    expect(children.every((child) => child.request === undefined)).toBe(true);
    expect(children.map((child) => child.runTiming?.elapsedMs)).toEqual([9000, 9000]);
  } finally {
    display.dispose();
  }
});

test("A single-child receipt binds only its own authored tool input to the concrete status row", () => {
  // The parent knows the actual direct tool input even though lifecycle events redact it.
  const events = createEventBus(),
    display = new PiSubagentDisplay(events, () => {});
  try {
    display.handleEvent({
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "subagent",
      args: { agent: "implementer", task: "Review the Unicode 한글👩‍💻 input\nwithout changes" },
    });
    events.emit("subagent:async-started", {
      id: "direct",
      mode: "single",
      agent: "implementer",
      task: "[prompt redacted]",
    });
    display.handleEvent({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "subagent",
      result: { content: [], details: { mode: "single", asyncId: "direct" } },
      isError: false,
    });

    const children = expectOk(
      piSubagentsFromWidget(
        widget([
          {
            id: "direct",
            kind: "subagent",
            label: "implementer",
            state: "running",
            children: [
              { id: "step:0", kind: "step", label: "Test implementer response", state: "running" },
            ],
          },
        ]),
        display.lookup,
      ),
    );

    // Wrapper suppression must preserve the concrete child's input preview.
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      name: "implementer",
      request: { text: "Review the Unicode 한글👩‍💻 input without changes", images: 0, files: 0 },
    });
  } finally {
    display.dispose();
  }
});

test("Redacted lifecycle prompts, invalid events and failed receipts never create input previews", () => {
  // Public events may provide names but do not authorize reconstructing hidden prompts.
  const events = createEventBus(),
    display = new PiSubagentDisplay(events, () => {});
  try {
    events.emit("subagent:async-started", {
      id: "direct",
      mode: "single",
      agent: "reviewer",
      task: "[prompt redacted]",
    });
    events.emit("subagent:child-status", {
      type: "subagent.child-status",
      version: 2,
      runId: "first",
      childId: "writer",
      agent: "wrong",
    });
    display.handleEvent({
      type: "tool_execution_start",
      toolCallId: "failed",
      toolName: "subagent",
      args: { agent: "reviewer", task: "Never accepted" },
    });
    display.handleEvent({
      type: "tool_execution_end",
      toolCallId: "failed",
      toolName: "subagent",
      result: { details: { mode: "single", asyncId: "direct" } },
      isError: true,
    });

    const children = expectOk(
      piSubagentsFromWidget(
        widget([
          { id: "direct", kind: "subagent", label: "Review task", state: "running" },
          workflow("first"),
        ]),
        display.lookup,
      ),
    );

    expect(children[0]?.name).toBe("reviewer");
    expect(children[0]?.request).toBeUndefined();
    expect(display.lookup("writer", "first")).toBeUndefined();
  } finally {
    display.dispose();
  }
});

test("Reset and disposal discard session-local display metadata and unsubscribe lifecycle observers", () => {
  // Reloaded sessions must not retain authored tasks or receive updates from disposed observers.
  const events = createEventBus();
  let changes = 0;
  const display = new PiSubagentDisplay(events, () => {
    changes++;
  });
  const start = () =>
    events.emit("subagent:async-started", { id: "direct", mode: "single", agent: "implementer" });
  start();
  expect(display.lookup("direct")?.name).toBe("implementer");

  display.reset();
  expect(display.lookup("direct")).toBeUndefined();
  display.dispose();
  start();

  expect(display.lookup("direct")).toBeUndefined();
  expect(changes).toBe(1);
});
