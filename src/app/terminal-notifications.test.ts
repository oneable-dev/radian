import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { NativeSession } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ExecutionState } from "../agents/session-registry.ts";
import type { RunCompletion } from "../agents/run-completion.ts";
import { SessionTranscript } from "../agents/transcript.ts";
import { fixtureMessage } from "../testing/offline-runtime.ts";
import type { WorkspaceSnapshot } from "../runtime/workspace-client.ts";
import { TerminalNotifications } from "./terminal-notifications.ts";

class Source {
  readonly listeners = new Set<() => void>();
  recoveryVersion = 0;
  constructor(public snapshot: WorkspaceSnapshot) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(state: ExecutionState): void {
    this.snapshot = { ...this.snapshot, details: { ...this.snapshot.details, session: state } };
    this.changed();
  }
  changed(): void { for (const listener of this.listeners) listener(); }
}
class Terminal extends EventEmitter {
  isDestroyed = false;
  accepted = true;
  failure: Error | undefined;
  readonly sent: { body: string; title: string | undefined }[] = [];
  triggerNotification(body: string, title?: string): boolean {
    this.sent.push({ body, title });
    if (this.failure) throw this.failure;
    return this.accepted;
  }
  destroy(): void { this.isDestroyed = true; this.emit("destroy"); }
}
function state(completions: readonly RunCompletion[] = [], status: ExecutionState["status"] = "complete", request = "Implement terminal notifications"): ExecutionState {
  return { conversationId: "conversation", status, output: "Private response", error: "Private provider error",
    sections: completions.flatMap((completion, index) => [
      { id: `request-${index}`, kind: "user", title: "You", text: request, status: "complete" },
      { id: `answer-${index}`, kind: "assistant", title: "Agent", text: "Private response", status: "complete", completion },
    ]) };
}
function snapshot(execution: ExecutionState = state()): WorkspaceSnapshot {
  return { repositories: [{ id: "repo", name: "radian", worktrees: [{ id: "tree", path: "/private/workspace", name: "main", branch: "main",
    sessions: [{ id: "session", name: "Notification work", status: execution.status, subagents: [] }] }] }], details: { session: execution },
    preferences: { selection: { worktreeId: "tree", sessions: {} }, drafts: {} }, closingCount: 0, notice: "" };
}
function completion(outcome: RunCompletion["outcome"] = "complete", startedAt = 1000): RunCompletion {
  return { startedAt, completedAt: startedAt + 42000, durationMs: 42000, outcome };
}
function fixture(initial = state()) {
  const source = new Source(snapshot(initial)), terminal = new Terminal(), errors: unknown[] = [];
  const notifications = new TerminalNotifications(terminal, source, (error) => errors.push(error));
  return { source, terminal, errors, notifications };
}

for (const focus of ["unknown", "blur", "focus"] as const) for (const outcome of ["complete", "error"] as const) {
  test(`Final ${outcome} results with ${focus} focus notify once according to policy`, () => {
    // Initial focus is unknown; replace only terminal delivery, not OS behavior.
    const app = fixture();
    if (focus !== "unknown") app.terminal.emit(focus);
    const finished = completion(outcome);
    try {
      // Heartbeats and persistence warnings for the same result are not new runs.
      app.source.publish(state([finished]));
      app.source.publish(state([{ ...finished, warning: "Timing persistence warning" }]));
      app.terminal.emit("blur"); app.source.changed();

      // Results consumed while focused must not replay after focus is lost.
      expect(app.terminal.sent).toEqual(focus === "focus" ? [] : [{
        title: outcome === "complete" ? "Radian · Task completed" : "Radian · Task failed",
        body: "Implement terminal notifications · 42s",
      }]);
      expect(app.errors).toEqual([]);
    } finally { app.notifications.dispose(); }
  });
}

test("Preconnection history, newly opened conversations, and reconnections notify only subsequent runs", () => {
  // Existing completion history establishes the initial notification baseline only.
  const old = completion(), app = fixture(state([old]));
  try {
    // Opening saved conversations or recovering services still represents historical data.
    app.source.changed();
    app.source.publish({ ...state([old, completion("error", 50000)]), conversationId: "resumed" });
    app.source.recoveryVersion++;
    const restored = [old, completion("error", 50000), completion("complete", 100000)];
    app.source.publish({ ...state(restored), conversationId: "resumed" });
    expect(app.terminal.sent).toHaveLength(0);

    // Detect completion after the baseline even if working snapshots were coalesced away.
    app.source.publish({ ...state([...restored, completion("complete", 150000)]), conversationId: "resumed" });
    expect(app.terminal.sent).toHaveLength(1);
  } finally { app.notifications.dispose(); }
});

test("Initial reads of other saved sessions never notify", () => {
  // Add another saved session while observing an existing session.
  const app = fixture();
  try {
    const repository = app.source.snapshot.repositories[0]!, tree = repository.worktrees[0]!;
    app.source.snapshot = { ...app.source.snapshot,
      repositories: [{ ...repository, worktrees: [{ ...tree, sessions: [...tree.sessions,
        { id: "saved", name: "Saved session", status: "complete", subagents: [] }] }] }],
      details: { ...app.source.snapshot.details, saved: state([completion()]) } };

    // Initial completions and later heartbeats are both consumed as history.
    app.source.changed(); app.source.changed();

    expect(app.terminal.sent).toEqual([]);
  } finally { app.notifications.dispose(); }
});

test("Responses and retries never notify before final settlement", () => {
  // Use actual transcript contracts to distinguish request completion from individual responses.
  const app = fixture(), transcript = new SessionTranscript([]);
  const assistant = fixtureMessage("openai-responses", "fixture", "fixture");
  assistant.content = [{ type: "text", text: "Private answer" }];
  const publish = () => app.source.publish({ ...state([], "working"), sections: transcript.sections });
  const message = (value: typeof assistant) => {
    transcript.handle({ type: "message_start", message: value });
    transcript.handle({ type: "message_end", message: value });
  };
  try {
    // Retryable failures and subsequent responses do not complete the whole request.
    transcript.handle({ type: "agent_start" });
    message({ ...assistant, stopReason: "error", errorMessage: "Retryable failure" });
    transcript.handle({ type: "agent_end", messages: [], willRetry: true }); publish();
    transcript.handle({ type: "agent_start" }); message(assistant);
    transcript.handle({ type: "agent_end", messages: [], willRetry: false }); publish();
    expect(app.terminal.sent).toHaveLength(0);

    // Deliver once only when final metadata is created.
    transcript.handle({ type: "agent_settled", aborted: false });
    app.source.publish({ ...state(), sections: transcript.sections }); app.source.changed();
    expect(app.terminal.sent).toHaveLength(1);
    expect(app.terminal.sent[0]?.title).toBe("Radian · Task completed");
  } finally { app.notifications.dispose(); }
});

test.each(["cancelled", "unfinished"] as const)("%s termination never creates success or failure notifications", (outcome) => {
  // Cancellation and unknown outcomes are neither success nor failure.
  const app = fixture();
  try {
    app.source.publish(state([completion(outcome)], null)); app.source.changed();

    expect(app.terminal.sent).toEqual([]);
  } finally { app.notifications.dispose(); }
});

test("Coalesced final runs each notify once and child state never notifies separately", () => {
  // Child state changes are not separate main-session completions.
  const app = fixture(), repository = app.source.snapshot.repositories[0]!, tree = repository.worktrees[0]!;
  try {
    app.source.snapshot = { ...app.source.snapshot, repositories: [{ ...repository, worktrees: [{ ...tree,
      sessions: [{ ...tree.sessions[0]!, subagents: [{ id: "child", name: "Probe", status: "complete" }] }] }] }] };
    app.source.changed();
    expect(app.terminal.sent).toHaveLength(0);

    // Process each result once even when multiple completions share one snapshot.
    app.source.publish(state([completion(), completion("error", 50000)])); app.source.changed();

    expect(app.terminal.sent.map((item) => item.title)).toEqual(["Radian · Task completed", "Radian · Task failed"]);
  } finally { app.notifications.dispose(); }
});

test("Completion summaries use only the same run's last request, never earlier or future requests", () => {
  // Combine multiple runs and a subsequent pending request in one snapshot.
  const app = fixture(), first = state([completion()], "complete", "First task").sections!;
  const second = state([completion("error", 50000)], "failure", "Second task").sections!.map((section) => ({ ...section, id: `second-${section.id}` }));
  try {
    app.source.publish({ ...state(), sections: [...first, ...second,
      { id: "background", kind: "assistant", title: "Agent", text: "Private response", status: "complete", completion: completion("complete", 100000) },
      { id: "future", kind: "user", title: "You", text: "Request for the next run", status: "complete" },
    ] });

    // Request-free runs show duration only; never borrow the following request.
    expect(app.terminal.sent.map((item) => item.body)).toEqual(["First task · 42s", "Second task · 42s", "42s"]);
  } finally { app.notifications.dispose(); }
});

test.each(["missing", "empty"] as const)("Request summary %s shows only duration instead of identifiers or responses", (request) => {
  // Historical or attachment-only requests may have no displayable task text.
  const app = fixture(), finished = state([completion()], "complete", "");
  try {
    app.source.publish({ ...finished, sections: request === "missing" ? finished.sections!.filter((section) => section.kind !== "user") : finished.sections! });

    expect(app.terminal.sent).toEqual([{ title: "Radian · Task completed", body: "42s" }]);
  } finally { app.notifications.dispose(); }
});

test("Skill notifications summarize invocation names rather than internal instructions", () => {
  // Skill notice bodies may contain private instructions rather than user task names.
  const app = fixture(), finished = state([completion()]);
  try {
    app.source.publish({ ...finished, sections: [
      { id: "skill", kind: "notice", title: "Skill", text: "PRIVATE_SKILL_INSTRUCTIONS", skillName: "review-code", status: "complete" },
      ...finished.sections!.filter((section) => section.kind !== "user"),
    ] });

    expect(app.terminal.sent[0]?.body).toBe("/skill:review-code · 42s");
    expect(app.terminal.sent[0]?.body).not.toContain("PRIVATE_SKILL_INSTRUCTIONS");
  } finally { app.notifications.dispose(); }
});

test("Structured task summaries override source text containing attachment paths", () => {
  // Distinguish runtime summaries from original conversation text.
  const app = fixture(), finished = state([completion()]);
  const request = { id: "request", kind: "user" as const, title: "You", text: 'Private raw request @"/private/workspace/secret.ts"', status: "complete" as const,
    request: { text: "Update the selected file", images: 0, files: 1, fileName: "secret.ts" } };
  try {
    app.source.publish({ ...finished, sections: [request, ...finished.sections!.filter((section) => section.kind !== "user")] });

    expect(app.terminal.sent[0]?.body).toBe("Update the selected file · 42s");
  } finally { app.notifications.dispose(); }
});

test.each([[0, "<1s"], [90000, "1m 30s"], [3604000, "1h 0m 4s"]] as const)("Run duration %dms displays as %s rather than session age", (durationMs, expected) => {
  // Use saved execution duration without adding current time or session idle time.
  const app = fixture();
  try {
    app.source.publish(state([{ ...completion(), durationMs }]));

    expect(app.terminal.sent[0]?.body).toBe(`Implement terminal notifications · ${expected}`);
  } finally { app.notifications.dispose(); }
});

test("Short summaries remove control characters and OSC separators while preserving duration", () => {
  // Request summaries may contain OSC terminators or separate control sequences.
  const app = fixture();
  try {
    app.source.publish(state([completion("error")], "failure", "\x1b[31mNotification\x1b[0m;\nimplementation\x07 " + "task".repeat(200) + "\x9c"));

    const sent = app.terminal.sent[0]!;
    expect(sent.body).toStartWith("Notification, implementation ");
    expect(sent.body).not.toMatch(/[\x00-\x1f\x7f-\x9f;]/u);
    expect(Bun.stringWidth(sent.body)).toBeLessThanOrEqual(240);
    expect(sent.body).toEndWith("… · 42s");
    expect(sent.body).not.toContain("Private"); expect(sent.body).not.toContain("/private/workspace");
    expect(sent.body).not.toContain("radian"); expect(sent.body).not.toContain("Notification work");
  } finally { app.notifications.dispose(); }
});

test.each(["dispose", "destroy"] as const)("%s cleans subscriptions and prevents future notifications", (action) => {
  // Detach and renderer shutdown both end notification ownership.
  const app = fixture();

  if (action === "dispose") app.notifications.dispose(); else app.terminal.destroy();
  app.notifications.dispose(); app.source.publish(state([completion()]));

  expect(app.source.listeners.size).toBe(0);
  expect(["focus", "blur", "destroy"].map((event) => app.terminal.listenerCount(event))).toEqual([0, 0, 0]);
  expect(app.terminal.sent).toEqual([]);
});

test("Unsupported terminals neither retry notifications nor alter outcomes", () => {
  // False means terminal delivery rejection, not confirmed OS display.
  const app = fixture(); app.terminal.accepted = false;
  try {
    app.source.publish(state([completion()])); app.source.changed();

    expect(app.terminal.sent).toHaveLength(1); expect(app.errors).toEqual([]);
    expect(app.source.snapshot.details.session?.status).toBe("complete");
  } finally { app.notifications.dispose(); }
});

test("Unexpected SDK errors reach the UI unchanged without redelivering results", () => {
  // Never disguise programming errors as ordinary unsupported outcomes.
  const app = fixture(), error = new Error("Unexpected notification failure"); app.terminal.failure = error;
  try {
    app.source.publish(state([completion()])); app.source.changed();

    expect(app.errors).toEqual([error]); expect(app.errors[0]).toBe(error);
    expect(app.terminal.sent).toHaveLength(1);
    expect(app.source.snapshot.details.session?.status).toBe("complete");
  } finally { app.notifications.dispose(); }
});

test("Unselected sessions in other repositories notify using their task summaries instead of identifiers", () => {
  // Focus policy applies to the entire TUI terminal, not the selected session.
  const app = fixture();
  const repository = { id: "other-repo", name: "server", worktrees: [{ id: "feature", path: "/private/server", name: "feature/api", branch: "feature/api",
    sessions: [{ id: "other-session", name: "API work", status: "working" as const, subagents: [] }] }] };
  try {
    app.source.snapshot = { ...app.source.snapshot, repositories: [...app.source.snapshot.repositories, repository],
      details: { ...app.source.snapshot.details, "other-session": state([], "working") } };
    app.source.changed();

    // Completion in another repository stays separate from the main session.
    app.source.snapshot = { ...app.source.snapshot, details: { ...app.source.snapshot.details, "other-session": state([completion()], "complete", "Fix API errors") } };
    app.source.changed(); app.source.changed();

    expect(app.terminal.sent).toEqual([{ title: "Radian · Task completed", body: "Fix API errors · 42s" }]);
  } finally { app.notifications.dispose(); }
});

test("Ghostty native output delivers actual OSC 777 notifications through ordered output queues", async () => {
  // Capture bytes in Writable instead of a real terminal without replacing native delivery.
  let raw = "";
  const sink = new Writable({ write(bytes, _encoding, done) { raw += bytes.toString(); done(); } });
  const driver = new NativeSession(sink), source = new Source(snapshot()), errors: unknown[] = [];
  const terminal = Object.assign(new EventEmitter(), { isDestroyed: false,
    triggerNotification: (body: string, title?: string) => driver.triggerNotification(body, title) });
  let notifications: TerminalNotifications | undefined;
  try {
    driver.attachRenderer({ width: 40, height: 8, remote: false, environment: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" } });
    await driver.setupTerminal({ useAlternateScreen: false, mouse: false, kittyKeyboardFlags: 0 });
    // Ghostty mode-query support responses enable OpenTUI focus tracking.
    driver.control({ kind: "capability-response", bytes: Buffer.from("\x1b[?1004;2$y") });
    await driver.idle(); expect(raw).toContain("\x1b[?1004h");
    raw = "";
    notifications = new TerminalNotifications(terminal, source, (error) => errors.push(error));

    // Notifications are OSC control packets interpreted by Ghostty, not screen text.
    source.publish(state([completion()])); await driver.idle();

    expect(raw).toBe("\x1b]777;notify;Radian · Task completed;Implement terminal notifications · 42s\x1b\\");
    expect(errors).toEqual([]);
  } finally { notifications?.dispose(); await driver.close(); }
});

test("Real OpenTUI focus parser signals update notification delivery", async () => {
  // Replace only terminal output while using real input parsing and renderer events.
  const app = await createTestRenderer({ width: 40, height: 8 });
  const source = new Source(snapshot()), errors: unknown[] = [];
  const send = spyOn(app.renderer, "triggerNotification").mockReturnValue(true);
  const notifications = new TerminalNotifications(app.renderer, source, (error) => errors.push(error));
  try {
    // Completion while focused never notifies.
    app.renderer.stdin.emit("data", Buffer.from("\x1b[I")); await app.renderOnce();
    source.publish(state([completion()]));
    expect(send).not.toHaveBeenCalled();

    // Fresh results after focus loss deliver exactly once through native output.
    app.renderer.stdin.emit("data", Buffer.from("\x1b[O")); await app.renderOnce();
    source.publish(state([completion(), completion("error", 50000)])); source.changed();
    expect(send.mock.calls).toEqual([["Implement terminal notifications · 42s", "Radian · Task failed"]]);
    expect(errors).toEqual([]);
  } finally { notifications.dispose(); send.mockRestore(); await app.dispose(); }
});
