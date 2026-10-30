import { needsAttention } from "../agents/session-attention.ts";
import type { SessionNotification } from "../agents/session-notification.ts";
import type { WorkspaceClient } from "../runtime/workspace-client.ts";
import { sessionSources } from "./session-sources.ts";

type Source = Pick<WorkspaceClient, "snapshot" | "recoveryVersion" | "subscribe">;

type ObservedSession = { conversationId: string | undefined; results: Set<string> };

// In-app delivery is independent of terminal focus and of whether a result was read.
export class SessionNotifications {
  private readonly unsubscribe: () => void;
  private observed = new Map<string, ObservedSession>();
  private recovery: number;
  private disposed = false;

  constructor(
    private readonly source: Source,
    private readonly deliver: (notification: SessionNotification) => void,
  ) {
    this.recovery = source.recoveryVersion;
    this.update(true);
    this.unsubscribe = source.subscribe(this.changed);
  }

  private changed = (): void => {
    if (this.disposed) {
      return;
    }

    const restored = this.recovery !== this.source.recoveryVersion;
    this.recovery = this.source.recoveryVersion;
    this.update(restored);
  };

  private update(baseline: boolean): void {
    const snapshot = this.source.snapshot;
    const next = new Map<string, ObservedSession>();
    const notifications: SessionNotification[] = [];
    for (const source of sessionSources(snapshot)) {
      for (const session of source.sessions) {
        const state = snapshot.details[session.id];
        const previous = this.observed.get(session.id);
        if (!state) {
          if (previous) {
            next.set(session.id, previous);
          }

          continue;
        }

        const initial = baseline || !previous || previous.conversationId !== state.conversationId;
        const observed = initial
          ? { conversationId: state.conversationId, results: new Set<string>() }
          : previous;
        // Attention can retain a result after the next run starts and clears `result`.
        // Conversely, a foreground acknowledgement can remove attention before delivery.
        for (const result of [session.attention, session.result]) {
          if (!result || observed.results.has(result.id)) {
            continue;
          }

          observed.results.add(result.id);
          if (initial || !needsAttention(result)) {
            continue;
          }

          const completion = state.sections?.findLast(
            (section) =>
              section.completion?.completedAt === result.completedAt &&
              section.completion.outcome === result.outcome,
          )?.completion;
          notifications.push({
            id: JSON.stringify([session.id, state.conversationId, result.id]),
            sessionId: session.id,
            worktreeId: source.scopeId,
            conversationId: state.conversationId,
            repository: source.repository,
            worktree: source.name,
            branch: source.branch,
            result,
            ...(completion ? { durationMs: completion.durationMs } : {}),
          });
        }

        next.set(session.id, observed);
      }
    }

    // Delivery may synchronously change selection or publish another snapshot.
    this.observed = next;
    for (const notification of notifications) {
      this.deliver(notification);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unsubscribe();
    this.observed.clear();
  }
}
