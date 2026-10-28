import { CancelledError, type ExpectedError } from "../errors.ts";
import { err, type Result } from "../result.ts";
import type { HistoryPreview } from "./history-preview.ts";

export type PreviewState =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly value: HistoryPreview }
  | { readonly kind: "error"; readonly error: ExpectedError }
  | { readonly kind: "unexpected"; readonly message: string };
type Entry = {
  key: string;
  worktreeId: string;
  savedId: string;
  abort: AbortController;
  state: PreviewState;
  units: number;
  revision?: string;
};
type Loader = (
  worktreeId: string,
  savedId: string,
  signal: AbortSignal,
) => Promise<Result<HistoryPreview, ExpectedError>>;
const keyFor = (worktreeId: string, savedId: string) => JSON.stringify([worktreeId, savedId]);
const maximumEntries = 200;
// A serialized-text budget, not a claim about total JavaScript/native heap usage.
const maximumUnits = 8 * 1024 * 1024;

// May outlive History popups. Only plain data is cached, never native renderables.
export class HistoryPreviewCache {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<Entry>();
  private readonly background: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly versions = new Map<string, ReadonlyMap<string, string>>();
  private queued: Entry | undefined;
  private selected: string | undefined;
  private units = 0;
  private backgroundFull = false;

  constructor(
    private readonly load: Loader,
    private readonly changed: () => void,
    private readonly unexpected: (error: unknown) => string,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    this.changed();
    for (const listener of this.listeners) listener();
  }
  read(worktreeId: string, savedId: string): PreviewState | undefined {
    return this.entries.get(keyFor(worktreeId, savedId))?.state;
  }

  preload(worktreeId: string, items: readonly { id: string; revision: string }[]): void {
    this.versions.set(worktreeId, new Map(items.map((item) => [item.id, item.revision])));
    const versions = new Map(items.map((item) => [keyFor(worktreeId, item.id), item.revision]));
    for (const [key, entry] of this.entries)
      if (
        entry.worktreeId === worktreeId &&
        (!versions.has(key) || entry.revision !== versions.get(key))
      ) {
        entry.abort.abort();
        this.entries.delete(key);
        this.units -= entry.units;
        if (this.queued === entry) this.queued = undefined;
      }
    this.pruneBackground();
    this.backgroundFull = false;
    for (const item of items.slice(0, maximumEntries)) {
      const key = keyFor(worktreeId, item.id);
      if (this.entries.has(key)) continue;
      if (this.entries.size >= maximumEntries) break;
      const entry: Entry = {
        key,
        worktreeId,
        savedId: item.id,
        revision: item.revision,
        abort: new AbortController(),
        state: { kind: "pending" },
        units: 0,
      };
      this.entries.set(key, entry);
      this.background.push(entry);
    }
    this.drain();
    this.emit();
  }

  retain(worktrees: ReadonlySet<string>): void {
    for (const tree of this.versions.keys()) if (!worktrees.has(tree)) this.versions.delete(tree);
    for (const [key, entry] of this.entries)
      if (!worktrees.has(entry.worktreeId)) {
        entry.abort.abort();
        this.entries.delete(key);
        this.units -= entry.units;
      }
    this.pruneBackground();
  }

  private pruneBackground(): void {
    for (let index = this.background.length - 1; index >= 0; index--) {
      const entry = this.background[index]!;
      if (this.entries.get(entry.key) !== entry) this.background.splice(index, 1);
    }
  }

  select(worktreeId: string, savedId: string): PreviewState {
    const key = keyFor(worktreeId, savedId);
    this.unselect();
    this.selected = key;
    let entry = this.entries.get(key);
    const revision = this.versions.get(worktreeId)?.get(savedId);
    if (!entry)
      entry = {
        key,
        worktreeId,
        savedId,
        abort: new AbortController(),
        state: { kind: "pending" },
        units: 0,
        ...(revision === undefined ? {} : { revision }),
      };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.state.kind === "pending" && !this.active.has(entry)) this.queued = entry;
    this.drain();
    this.trim();
    return entry.state;
  }

  unselect(): void {
    if (this.queued && this.queued.revision === undefined) this.entries.delete(this.queued.key);
    this.queued = undefined;
    this.selected = undefined;
  }
  clear(): void {
    for (const entry of this.active) entry.abort.abort();
    this.active.clear();
    this.entries.clear();
    this.versions.clear();
    this.background.length = 0;
    this.queued = undefined;
    this.selected = undefined;
    this.units = 0;
    this.backgroundFull = false;
  }

  private drain(): void {
    while (this.active.size < 2) {
      const entry = this.queued ?? (!this.backgroundFull ? this.background.shift() : undefined);
      if (!entry) return;
      this.queued = undefined;
      if (this.entries.get(entry.key) !== entry || this.active.has(entry)) continue;
      this.active.add(entry);
      void Promise.resolve()
        .then(() =>
          entry.abort.signal.aborted
            ? err(new CancelledError())
            : this.load(entry.worktreeId, entry.savedId, entry.abort.signal),
        )
        .then((result) => {
          if (this.entries.get(entry.key) !== entry) return;
          const units = result.ok
            ? JSON.stringify(result.value).length
            : result.error.message.length;
          if (
            entry.revision !== undefined &&
            entry.key !== this.selected &&
            !this.makeRoomForBackground(entry, units)
          ) {
            this.emit();
            return;
          }
          entry.state = result.ok
            ? { kind: "ready", value: result.value }
            : { kind: "error", error: result.error };
          entry.units = units;
          this.units += units;
          this.trim();
          this.emit();
        })
        .catch((error: unknown) => {
          // Preserve programming errors at the host/UI boundary, including after popup closure.
          const message = this.unexpected(error);
          if (this.entries.get(entry.key) !== entry) return;
          entry.state = { kind: "unexpected", message };
          entry.units = message.length;
          this.units += entry.units;
          this.trim();
          this.emit();
        })
        .finally(() => {
          this.active.delete(entry);
          this.trim();
          this.drain();
        });
    }
  }

  private makeRoomForBackground(entry: Entry, units: number): boolean {
    if (this.units + units <= maximumUnits) return true;
    this.stopBackground();
    if (units <= maximumUnits) {
      // Insertion order follows newest-first preload priority, not request completion order.
      // A slow recent read may replace older speculation, never the other way around.
      const entries = [...this.entries.values()];
      for (const older of entries.slice(entries.indexOf(entry) + 1).reverse()) {
        if (
          older.key === this.selected ||
          older === this.queued ||
          (this.active.has(older) && older.state.kind === "pending")
        )
          continue;
        this.entries.delete(older.key);
        this.units -= older.units;
        if (this.units + units <= maximumUnits) return true;
      }
    }
    this.entries.delete(entry.key);
    return false;
  }

  private stopBackground(): void {
    this.backgroundFull = true;
    for (const entry of this.background)
      if (this.entries.get(entry.key) === entry && !this.active.has(entry) && this.queued !== entry)
        this.entries.delete(entry.key);
    this.background.length = 0;
  }

  private trim(): void {
    if (this.units > maximumUnits) this.stopBackground();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= maximumEntries && this.units <= maximumUnits) break;
      if (key === this.selected || this.active.has(entry) || this.queued === entry) continue;
      this.entries.delete(key);
      this.units -= entry.units;
    }
  }
}
