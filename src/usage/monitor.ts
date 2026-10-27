import { CancelledError, UsageError, reportUnexpected, type ExpectedError } from "../errors.ts";
import { err, type Result } from "../result.ts";
import type { ProviderUsage, UsageAccount, UsageRefreshMode, UsageResolver, UsageSubscription, UsageWindow } from "./model.ts";

type Timer = ReturnType<typeof setTimeout> | number;
type Clock = { now(): number; setTimeout(callback: () => void, delay: number): Timer; clearTimeout(timer: Timer): void };
const systemClock: Clock = { now: Date.now, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout };
const intervalMs = 60000;
const maxBackoffMs = 300000;
const empty = (provider: string, status: ProviderUsage["status"] = "loading", errorCode: ProviderUsage["errorCode"] = null): ProviderUsage =>
  ({ provider, status, windows: [], updatedAt: null, errorCode });
const failed = (previous: ProviderUsage, error: ExpectedError): ProviderUsage =>
  ({ ...previous, status: "error", errorCode: error instanceof UsageError ? error.code : "USAGE_QUERY_FAILED" });
type RefreshMode = "cached" | UsageRefreshMode;
type RetryState = { failures: number; retryAt: number; retryAfterAt: number };
type AccountCache = { snapshot: ProviderUsage; attemptedAt: number; retry?: RetryState; pending?: Promise<ProviderUsage> };

// One runtime owns polling and account-keyed deduplication; UI instances only consume snapshots.
export class UsageMonitor {
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly snapshots = new Map<string, ProviderUsage>();
  private readonly accountKeys = new Map<string, string>();
  private readonly accounts = new Map<string, AccountCache>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly providerRetries = new Map<string, RetryState>();
  private readonly controllers = new Set<AbortController>();
  private timer: Timer | undefined;
  private active = false;
  private nextPollAt: number | null = null;
  private stopped = false;

  constructor(private readonly resolve: UsageResolver, private readonly clock: Clock = systemClock, private readonly random: () => number = Math.random) {}

  watch(changed: () => void): UsageSubscription {
    let provider: string | null = null, disposed = false;
    const remove = () => {
      if (provider === null) return;
      const callbacks = this.watchers.get(provider);
      callbacks?.delete(changed);
      if (!callbacks?.size) {
        this.watchers.delete(provider); this.snapshots.delete(provider); this.accountKeys.delete(provider);
        this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
        this.pending.delete(provider); this.providerRetries.delete(provider);
      }
    };
    return {
      read: (next) => {
        if (this.stopped) return empty(next ?? "", "unavailable");
        if (!disposed && next !== provider) {
          remove(); provider = next;
          if (provider !== null) {
            const callbacks = this.watchers.get(provider) ?? new Set();
            callbacks.add(changed); this.watchers.set(provider, callbacks);
            void this.refresh(provider);
          }
        }
        return provider === null ? empty("", "unavailable") : this.snapshots.get(provider) ?? empty(provider);
      },
      refresh: (mode = "automatic") => { if (!disposed && provider !== null) void this.refresh(provider, mode); },
      dispose: () => { if (disposed) return; disposed = true; remove(); this.schedule(); },
    };
  }

  invalidate(provider: string): void {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.pending.delete(provider); this.accountKeys.delete(provider); this.providerRetries.delete(provider);
    this.publish(provider, empty(provider));
    if (this.watchers.has(provider)) void this.refresh(provider, "automatic");
  }

  setActive(active: boolean): void {
    if (this.active === active || this.stopped) return;
    this.active = active; this.nextPollAt = active ? this.clock.now() + intervalMs : null;
    if (active) for (const provider of this.watchers.keys()) void this.refresh(provider);
    this.schedule();
  }

  private refresh(provider: string, mode: RefreshMode = "cached"): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pending.get(provider); if (existing) return existing;
    if (this.clock.now() < this.retryAt(provider, mode)) return Promise.resolve();
    // Defer callbacks until registration/reading a snapshot has finished, avoiding recursive publication.
    const generation = this.generations.get(provider) ?? 0;
    const task = Promise.resolve().then(() => this.perform(provider, mode, generation)).catch((error: unknown) => {
      reportUnexpected(error, "usage refresh");
      if ((this.generations.get(provider) ?? 0) === generation) this.fail(provider, new UsageError("USAGE_QUERY_FAILED", "Unexpected usage refresh failure."));
    }).finally(() => {
      if (this.pending.get(provider) === task) this.pending.delete(provider);
      this.jobs.delete(task); this.schedule();
    });
    this.pending.set(provider, task); this.jobs.add(task); return task;
  }

  private async perform(provider: string, mode: RefreshMode, generation: number): Promise<void> {
    if (this.stopped || (this.generations.get(provider) ?? 0) !== generation) return;
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = this.clock.setTimeout(() => controller.abort(new UsageError("USAGE_TIMEOUT", "Usage lookup timed out.")), 10000);
    let aborted: (() => void) | undefined;
    const abort = new Promise<Result<ProviderUsage, ExpectedError>>((resolve) => {
      aborted = () => resolve(err(controller.signal.reason instanceof UsageError ? controller.signal.reason : new CancelledError()));
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    const lookup = this.lookup(provider, mode, controller.signal, generation).catch((error: unknown): Result<ProviderUsage, ExpectedError> => {
      // This is the background host boundary, not ordinary provider/input error classification.
      reportUnexpected(error, "usage source");
      return err(new UsageError("USAGE_QUERY_FAILED", "Unexpected usage lookup failure."));
    });
    try {
      const result = await Promise.race([lookup, abort]);
      if (this.stopped || (this.generations.get(provider) ?? 0) !== generation) return;
      if (result.ok) { this.providerRetries.delete(provider); this.publish(provider, result.value); }
      else if (!(result.error instanceof CancelledError)) this.fail(provider, result.error);
    } finally {
      this.clock.clearTimeout(timeout); this.controllers.delete(controller);
      if (aborted) controller.signal.removeEventListener("abort", aborted);
    }
  }

  private async lookup(provider: string, mode: RefreshMode, signal: AbortSignal, generation: number): Promise<Result<ProviderUsage, ExpectedError>> {
    if (this.stopped || signal.aborted) return err(new CancelledError());
    const resolved = await this.resolve(provider, signal);
    if (this.stopped || signal.aborted || (this.generations.get(provider) ?? 0) !== generation) return err(new CancelledError());
    if (!resolved.ok) return resolved;
    const account = resolved.value;
    if (!account) { this.accountKeys.delete(provider); return { ok: true, value: empty(provider, "unavailable") }; }
    if (this.accountKeys.get(provider) !== account.key) {
      this.accountKeys.set(provider, account.key);
      this.publish(provider, empty(account.provider));
    }
    const cached = this.accounts.get(account.key);
    if (cached?.pending) return { ok: true, value: await cached.pending };
    const now = this.clock.now();
    const expired = cached?.snapshot.windows.some((window) => window.resetsAt !== null && window.resetsAt <= now);
    const retryAt = mode === "manual" ? cached?.retry?.retryAfterAt : cached?.retry?.retryAt;
    const cacheMs = mode === "manual" ? 0 : mode === "automatic" ? 2000 : intervalMs;
    if (cached && (now < (retryAt ?? 0) || !expired && now - cached.attemptedAt < cacheMs)) {
      return { ok: true, value: cached.snapshot };
    }
    const entry: AccountCache = cached ?? { snapshot: empty(account.provider), attemptedAt: now };
    entry.attemptedAt = now;
    const releasePending = () => { if (entry.pending === job) delete entry.pending; };
    const job = this.load(account, signal, entry).then(({ snapshot, retry }) => {
      if (!this.stopped && !signal.aborted && entry.pending === job) {
        entry.snapshot = snapshot;
        if (retry) entry.retry = retry; else delete entry.retry;
        for (const [name, key] of this.accountKeys) if (key === account.key) this.publish(name, snapshot);
      }
      return snapshot;
    }).catch((error: unknown) => {
      if (!this.stopped && !signal.aborted && entry.pending === job) {
        const failure = new UsageError("USAGE_QUERY_FAILED", "Unexpected account usage failure.");
        entry.snapshot = failed(entry.snapshot, failure); entry.retry = this.backoff(entry.retry, failure);
      }
      throw error;
    }).finally(() => { releasePending(); signal.removeEventListener("abort", releasePending); });
    entry.pending = job; this.accounts.set(account.key, entry);
    signal.addEventListener("abort", releasePending, { once: true });
    if (signal.aborted) releasePending();
    return { ok: true, value: await job };
  }

  private async load(account: UsageAccount, signal: AbortSignal, previous: AccountCache): Promise<{ snapshot: ProviderUsage; retry?: RetryState }> {
    const result = await account.load(signal);
    if (!result.ok) return { snapshot: failed(previous.snapshot, result.error), retry: this.backoff(previous.retry, result.error) };
    return { snapshot: { provider: account.provider, status: result.value.length ? "ready" : "unavailable", windows: result.value,
      updatedAt: this.clock.now(), errorCode: null } };
  }

  private backoff(previous: RetryState | undefined, error: ExpectedError): RetryState {
    const failures = Math.min((previous?.failures ?? 0) + 1, 4);
    const base = Math.min(maxBackoffMs, intervalMs * 2 ** (failures - 1));
    const delay = Math.min(maxBackoffMs, Math.round(base * (1 + this.random() * 0.1)));
    const retryAfter = error instanceof UsageError ? error.retryAfterMs ?? 0 : 0;
    const now = this.clock.now();
    return { failures, retryAt: now + Math.max(delay, retryAfter), retryAfterAt: retryAfter > 0 ? now + retryAfter : 0 };
  }

  private fail(provider: string, error: ExpectedError): void {
    this.providerRetries.set(provider, this.backoff(this.providerRetries.get(provider), error));
    this.publish(provider, failed(this.snapshots.get(provider) ?? empty(provider), error));
  }

  private retryAt(provider: string, mode: RefreshMode = "cached"): number {
    const key = this.accountKeys.get(provider), account = key === undefined ? undefined : this.accounts.get(key);
    // Explicit reloads bypass our backoff, never a server-imposed Retry-After deadline.
    const deadline = (retry: RetryState | undefined) => (mode === "manual" ? retry?.retryAfterAt : retry?.retryAt) ?? 0;
    return Math.max(deadline(this.providerRetries.get(provider)), deadline(account?.retry));
  }

  private nextRefreshAt(provider: string, now: number): number {
    const retryAt = this.retryAt(provider);
    if (retryAt) return retryAt;
    const resets = (this.snapshots.get(provider)?.windows ?? [])
      .flatMap((window: UsageWindow) => window.resetsAt !== null && window.resetsAt > now ? [window.resetsAt] : []);
    return Math.min(this.nextPollAt ?? now + intervalMs, ...resets);
  }

  private publish(provider: string, snapshot: ProviderUsage): void {
    if (this.stopped) return;
    if (JSON.stringify(this.snapshots.get(provider)) === JSON.stringify(snapshot)) return;
    this.snapshots.set(provider, snapshot);
    // Subscribers may unsubscribe or add listeners while handling this publication.
    const watchers = [...this.watchers.get(provider) ?? []];
    for (const changed of watchers) changed();
  }

  private schedule(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.active || !this.watchers.size) { this.nextPollAt = null; return; }
    const now = this.clock.now();
    this.nextPollAt ??= now + intervalMs;
    const scheduled = [...this.watchers.keys()].filter(provider => !this.pending.has(provider))
      .map(provider => ({ provider, at: this.nextRefreshAt(provider, now) }));
    if (!scheduled.length) return; // Pending lookups own their timeout and reschedule on settlement.
    const delay = Math.max(1000, Math.min(2147483647, ...scheduled.map(({ at }) => at - now)));
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      const now = this.clock.now();
      if (this.nextPollAt !== null && this.nextPollAt <= now) this.nextPollAt = now + intervalMs;
      for (const { provider, at } of scheduled) if (at <= now && this.watchers.has(provider)) void this.refresh(provider, "automatic");
      // Skipping a lookup during backoff must not terminate periodic polling.
      this.schedule();
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.jobs);
    this.watchers.clear(); this.accounts.clear(); this.snapshots.clear();
  }
}
