import { expect, test } from "bun:test";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import type { ExecutionState } from "../agents/session-registry.ts";
import type { TranscriptSection } from "../agents/transcript.ts";
import { expectError, expectOk } from "../testing/results.ts";
import type { RuntimeSnapshot } from "./protocol.ts";
import { TranscriptFrames, TranscriptStore, withoutSections } from "./transcript-frames.ts";

function section(id: string, text = id): TranscriptSection {
  return { id, kind: "assistant", title: "Agent", text, status: "complete" };
}

function state(sections?: readonly TranscriptSection[]): ExecutionState {
  return { status: "complete", output: "", error: null, ...(sections ? { sections } : {}) };
}

function snapshot(
  details: Record<string, ExecutionState>,
  transcripts?: RuntimeSnapshot["transcripts"],
): RuntimeSnapshot {
  return {
    version: 1,
    pid: 1,
    instance: "fixture",
    mode: "offline",
    repositoryId: "/repo/.git",
    repositories: [],
    details,
    closingCount: 0,
    preferences: { selection: { worktreeId: null, sessions: {} }, drafts: {} },
    notice: "",
    ...(transcripts ? { transcripts } : {}),
  };
}

test("A stream's first frame carries every transcript and later frames only changes", () => {
  // Session details never carry sections on a transcript stream.
  const frames = new TranscriptFrames();
  const a = [section("a1"), section("a2")];
  const b = [section("b1")];

  const first = frames.split({ a: state(a), b: state(b) });
  expect(first.details).toEqual({ a: state(), b: state() });
  expect(first.transcripts).toEqual({
    a: { ids: ["a1", "a2"], sections: a },
    b: { ids: ["b1"], sections: b },
  });

  // Unchanged sections arrays are skipped by reference.
  expect(frames.split({ a: state(a), b: state(b) }).transcripts).toEqual({});

  // A rebuilt array with one streaming tail change sends only that section, in the same order.
  const streamed = [section("a1"), section("a2", "a2 more")];
  expect(frames.split({ a: state(streamed), b: state(b) }).transcripts).toEqual({
    a: { sections: [section("a2", "a2 more")] },
  });

  // Rebuilt but identical content sends nothing; an appended section includes the new order.
  expect(frames.split({ a: state([...streamed]), b: state(b) }).transcripts).toEqual({});
  const appended = [...streamed, section("a3")];
  expect(frames.split({ a: state(appended), b: state(b) }).transcripts).toEqual({
    a: { ids: ["a1", "a2", "a3"], sections: [section("a3")] },
  });
});

test("Removed sessions lose their baseline and return in full", () => {
  const frames = new TranscriptFrames();
  const a = [section("a1")];
  frames.split({ a: state(a) });

  expect(frames.split({}).transcripts).toEqual({});
  expect(frames.split({ a: state(a) }).transcripts).toEqual({ a: { ids: ["a1"], sections: a } });
});

test("Sessions without sections keep legacy output and send no transcript", () => {
  const frames = new TranscriptFrames();

  const frame = frames.split({ legacy: { ...state(), output: "legacy output" } });

  expect(frame.details).toEqual({ legacy: { ...state(), output: "legacy output" } });
  expect(frame.transcripts).toEqual({});
});

test("Stores merge streamed changes back into session details and CHAT details", () => {
  // The client restores the same sections the server split out, including CHAT sessions.
  const frames = new TranscriptFrames();
  const store = new TranscriptStore();
  const a = [section("a1"), section("a2")];
  const first = frames.split({ a: state(a), chat: state([section("c1")]) });
  expectOk(store.apply(first.transcripts, true));

  const merged = store.merge({
    ...snapshot({ a: first.details.a!, untracked: state() }, first.transcripts),
    chat: {
      id: CHAT_SCOPE_ID,
      path: "/home",
      name: "CHAT",
      sessions: [],
      details: { chat: first.details.chat! },
      historyRevision: 0,
      accountsRevision: 0,
      closingCount: 0,
    },
  });

  expect(merged.transcripts).toBeUndefined();
  expect(merged.details.a?.sections).toEqual(a);
  expect(merged.details.untracked).toEqual(state());
  expect(merged.chat?.details.chat?.sections).toEqual([section("c1")]);

  // Changes keep unchanged section objects and the merged array stable until the next change.
  const next = frames.split({ a: state([section("a1"), section("a2", "edited")]) });
  expectOk(store.apply(next.transcripts, false));
  const updated = store.merge(snapshot(next.details));
  expect(updated.details.a?.sections).toEqual([section("a1"), section("a2", "edited")]);
  expect(updated.details.a?.sections?.[0]).toBe(merged.details.a!.sections![0]!);
  expect(store.merge(snapshot(next.details)).details.a?.sections).toBe(
    updated.details.a!.sections!,
  );
});

test("Stores drop transcripts of sessions that leave the snapshot and reset per stream", () => {
  const store = new TranscriptStore();
  expectOk(store.apply({ a: { ids: ["a1"], sections: [section("a1")] } }, true));
  store.merge(snapshot({}));

  // A dropped session needs a full transcript again before it can be merged.
  expect(expectError(store.apply({ a: { sections: [section("a1", "x")] } }, false)).code).toBe(
    "PROTOCOL_ERROR",
  );

  // A new stream replaces every transcript; sessions it does not list have none.
  expectOk(store.apply({ b: { ids: ["b1"], sections: [section("b1")] } }, true));
  const merged = store.merge(snapshot({ a: state(), b: state() }));
  expect(merged.details.a?.sections).toBeUndefined();
  expect(merged.details.b?.sections).toEqual([section("b1")]);
});

test("Order changes must reference delivered sections", () => {
  const store = new TranscriptStore();

  expect(expectError(store.apply({ a: { ids: ["missing"], sections: [] } }, true)).code).toBe(
    "PROTOCOL_ERROR",
  );
});

test("Lifecycle snapshots omit sections without changing other session state", () => {
  expect(withoutSections({ a: state([section("a1")]) })).toEqual({ a: state() });
});
