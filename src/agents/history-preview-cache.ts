import { CancelledError, type ExpectedError } from "../errors.ts";
import { err, type Result } from "../result.ts";
import type { HistoryPreview } from "./history-preview.ts";

export type PreviewState = { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly value: HistoryPreview }
  | { readonly kind: "error"; readonly error: ExpectedError }
  | { readonly kind: "unexpected"; readonly message: string };
type Entry = { key: string; worktreeId: string; savedId: string; abort: AbortController; state: PreviewState; units: number };
type Loader = (worktreeId: string, savedId: string, signal: AbortSignal) => Promise<Result<HistoryPreview, ExpectedError>>;
const keyFor = (worktreeId: string, savedId: string) => JSON.stringify([worktreeId, savedId]);
const maximumEntries = 200;
// A serialized-text budget, not a claim about total JavaScript/native heap usage.
const maximumUnits = 8 * 1024 * 1024;

// Owned by one open History popup. Only plain data is cached, never native renderables.
export class HistoryPreviewCache {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<Entry>();
  private queued: Entry | undefined;
  private selected: string | undefined;
  private units = 0;

  constructor(private readonly load: Loader, private readonly changed: () => void,
    private readonly unexpected: (error: unknown) => string) {}

  read(worktreeId: string, savedId: string): PreviewState | undefined { return this.entries.get(keyFor(worktreeId, savedId))?.state; }

  select(worktreeId: string, savedId: string): PreviewState {
    const key = keyFor(worktreeId, savedId);
    this.unselect(); this.selected = key;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, worktreeId, savedId, abort: new AbortController(), state: { kind: "pending" }, units: 0 };
    }
    this.entries.delete(key); this.entries.set(key, entry);
    if (entry.state.kind === "pending" && !this.active.has(entry)) this.queued = entry;
    this.drain(); this.trim();
    return entry.state;
  }

  unselect(): void {
    if (this.queued) this.entries.delete(this.queued.key);
    this.queued = undefined; this.selected = undefined;
  }

  clear(): void {
    for (const entry of this.active) entry.abort.abort();
    this.active.clear(); this.entries.clear(); this.queued = undefined; this.selected = undefined; this.units = 0;
  }

  private drain(): void {
    if (this.active.size >= 2 || !this.queued) return;
    const entry = this.queued; this.queued = undefined; this.active.add(entry);
    void Promise.resolve().then(() => entry.abort.signal.aborted ? err(new CancelledError())
      : this.load(entry.worktreeId, entry.savedId, entry.abort.signal)).then(result => {
      if (this.entries.get(entry.key) !== entry) return;
      entry.state = result.ok ? { kind: "ready", value: result.value } : { kind: "error", error: result.error };
      entry.units = result.ok ? JSON.stringify(result.value).length : result.error.message.length;
      this.units += entry.units; this.trim();
      if (this.selected === entry.key) this.changed();
    }).catch((error: unknown) => {
      // The owning UI logs programming failures with the original cause/stack, even after closure.
      const message = this.unexpected(error);
      if (this.entries.get(entry.key) !== entry) return;
      entry.state = { kind: "unexpected", message }; entry.units = message.length;
      this.units += entry.units; this.trim();
      if (this.selected === entry.key) this.changed();
    }).finally(() => { this.active.delete(entry); this.trim(); this.drain(); });
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= maximumEntries && this.units <= maximumUnits) break;
      if (key === this.selected || this.active.has(entry) || this.queued === entry) continue;
      this.entries.delete(key); this.units -= entry.units;
    }
  }
}
