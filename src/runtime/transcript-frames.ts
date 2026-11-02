import type { ExecutionState } from "../agents/session-registry.ts";
import type { TranscriptSection } from "../agents/transcript.ts";
import { ProtocolError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { RuntimeSnapshot, TranscriptUpdate } from "./protocol.ts";

type Details = Readonly<Record<string, ExecutionState>>;

/** Clients that merge transcript changes ask for them; older clients keep full session details. */
export function transcriptStream(request: Request): boolean {
  return new URL(request.url).searchParams.get("transcripts") === "1";
}

/** Session state without transcript sections, for snapshots that lifecycle checks read. */
export function withoutSections(details: Details): Record<string, ExecutionState> {
  return Object.fromEntries(
    Object.entries(details).map(([id, { sections: _sections, ...state }]) => [id, state]),
  );
}

type Sent = {
  readonly sections: readonly TranscriptSection[];
  readonly order: string;
  readonly json: ReadonlyMap<string, string>;
};

/**
 * The transcript baseline of one event stream. Frames are built only when the stream accepts
 * them, so each frame carries the changes since the previously delivered frame.
 */
export class TranscriptFrames {
  private readonly sent = new Map<string, Sent>();

  split(details: Details): {
    details: Record<string, ExecutionState>;
    transcripts: Record<string, TranscriptUpdate>;
  } {
    const transcripts: Record<string, TranscriptUpdate> = {};
    for (const [id, { sections }] of Object.entries(details)) {
      // Sessions without sections keep their legacy output rendering.
      if (!sections) {
        this.sent.delete(id);
        continue;
      }
      const previous = this.sent.get(id);
      // Transcripts cache their sections array until their content changes.
      if (previous?.sections === sections) continue;

      const ids = sections.map((section) => section.id);
      const order = JSON.stringify(ids);
      const json = new Map<string, string>();
      const changed: TranscriptSection[] = [];
      for (const section of sections) {
        const text = JSON.stringify(section);
        json.set(section.id, text);
        if (previous?.json.get(section.id) !== text) changed.push(section);
      }
      this.sent.set(id, { sections, order, json });
      const reordered = previous?.order !== order;
      if (reordered || changed.length) {
        transcripts[id] = { ...(reordered ? { ids } : {}), sections: changed };
      }
    }
    for (const id of this.sent.keys()) {
      if (!(id in details)) this.sent.delete(id);
    }

    return { details: withoutSections(details), transcripts };
  }
}

type Stored = {
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, TranscriptSection>;
  readonly sections: readonly TranscriptSection[];
};

/** Client-side transcripts rebuilt from one event stream's transcript changes. */
export class TranscriptStore {
  private readonly sessions = new Map<string, Stored>();

  /** The first frame of each stream replaces every earlier transcript. */
  apply(
    updates: Readonly<Record<string, TranscriptUpdate>>,
    reset: boolean,
  ): Result<void, ProtocolError> {
    if (reset) this.sessions.clear();
    for (const [id, update] of Object.entries(updates)) {
      const previous = this.sessions.get(id);
      const ids = update.ids ?? previous?.ids;
      if (!ids)
        return err(new ProtocolError("Transcript changes arrived before their transcript."));

      const byId = new Map(previous?.byId);
      for (const section of update.sections) byId.set(section.id, section);
      const sections: TranscriptSection[] = [];
      for (const sectionId of ids) {
        const section = byId.get(sectionId);
        if (!section) return err(new ProtocolError("Transcript order lists a missing section."));
        sections.push(section);
      }
      this.sessions.set(id, {
        ids,
        byId: new Map(sections.map((section) => [section.id, section])),
        sections,
      });
    }

    return ok(undefined);
  }

  /** Restores sections into session details that arrived without them. */
  merge(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const { transcripts: _transcripts, ...state } = snapshot;
    for (const id of this.sessions.keys()) {
      if (!(id in state.details) && !(state.chat && id in state.chat.details)) {
        this.sessions.delete(id);
      }
    }
    const restore = (details: Details) =>
      Object.fromEntries(
        Object.entries(details).map(([id, value]) => {
          const stored = this.sessions.get(id);
          return [id, stored ? { ...value, sections: stored.sections } : value];
        }),
      );

    return {
      ...state,
      details: restore(state.details),
      ...(state.chat ? { chat: { ...state.chat, details: restore(state.chat.details) } } : {}),
    };
  }
}
