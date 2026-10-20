import type { CliRenderer } from "@opentui/core";
import type { EventEmitter } from "node:events";
import type { WorkspaceClient } from "../runtime/workspace-client.ts";
import type { RunCompletion } from "../agents/run-completion.ts";
import { singleLine, truncateCells } from "../ui/text.ts";

type Source = Pick<WorkspaceClient, "snapshot" | "recoveryVersion" | "subscribe">;
type Terminal = Pick<EventEmitter, "on" | "off" | "once"> & Pick<CliRenderer, "isDestroyed" | "triggerNotification">;
type ObservedSession = { conversationId: string | undefined; completions: Set<string> };
type Notification = { title: string; body: string };

// Notifications belong to an attached terminal, never the detached service. Only
// settled run metadata is eligible; message/tool endings and retries are not.
export class TerminalNotifications {
  private focused: boolean | null = null;
  private disposed = false;
  private recovery: number;
  private observed = new Map<string, ObservedSession>();
  private readonly unsubscribe: () => void;

  constructor(private readonly terminal: Terminal, private readonly source: Source, private readonly unexpected: (error: unknown) => void) {
    this.recovery = source.recoveryVersion;
    this.update(true);
    this.unsubscribe = source.subscribe(this.changed);
    terminal.on("focus", this.focus); terminal.on("blur", this.blur); terminal.once("destroy", this.dispose);
  }

  private focus = (): void => { this.focused = true; };
  private blur = (): void => { this.focused = false; };
  private changed = (): void => {
    if (this.disposed || this.terminal.isDestroyed) return;
    const restored = this.recovery !== this.source.recoveryVersion;
    this.recovery = this.source.recoveryVersion;
    this.update(restored);
  };

  private update(baseline: boolean): void {
    const snapshot = this.source.snapshot;
    const next = new Map<string, ObservedSession>();
    const notifications: Notification[] = [];
    for (const repository of snapshot.repositories) for (const worktree of repository.worktrees) for (const session of worktree.sessions) {
      const state = snapshot.details[session.id];
      const previous = this.observed.get(session.id);
      if (!state?.sections) {
        if (previous) next.set(session.id, previous);
        continue;
      }
      const initial = baseline || !previous || previous.conversationId !== state.conversationId;
      const completions = new Set<string>();
      for (const section of state.sections) {
        const completion = section.completion;
        if (!completion) continue;
        // Persistence warnings are not another run or a reason to alert again.
        const key = JSON.stringify([section.id, completion.startedAt, completion.completedAt, completion.durationMs, completion.outcome]);
        completions.add(key);
        if (initial || previous.completions.has(key) || completion.outcome !== "complete" && completion.outcome !== "error") continue;
        // Never include prompt/response text, raw provider errors or full paths.
        const context = `${notificationName(repository.name, 64)} / ${notificationName(worktree.name, 64)} / ${notificationName(session.name, 80)}`;
        const body = `${context} · ${duration(completion)}`;
        notifications.push({ title: completion.outcome === "complete" ? "Radian · Task completed" : "Radian · Task failed", body });
      }
      next.set(session.id, { conversationId: state.conversationId, completions });
    }
    // Consume even focused/unsupported deliveries so blur, heartbeat or warning
    // updates cannot replay them. Commit before crossing the SDK output boundary.
    this.observed = next;
    if (this.focused === true) return;
    for (const notification of notifications) {
      try {
        // False means the terminal did not accept this best-effort notification;
        // true is not an acknowledgement from the OS notification center.
        if (!this.terminal.triggerNotification(notification.body, notification.title)) continue;
      } catch (error) { this.unexpected(error); }
    }
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe(); this.observed.clear();
    this.terminal.off("focus", this.focus); this.terminal.off("blur", this.blur); this.terminal.off("destroy", this.dispose);
  };
}

// Bound encoded size as well as display width, including zero-width input, and
// keep terminal controls and OSC 777 delimiters out of untrusted local names.
function notificationName(value: string, width: number): string {
  return truncateCells(singleLine(Bun.stripANSI(value.slice(0, 256))).replaceAll(";", ","), width);
}

function duration(completion: RunCompletion): string {
  const seconds = Math.floor(completion.durationMs / 1000);
  if (seconds < 1) return "<1s";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds % 60}s`].filter(Boolean).join(" ");
}
