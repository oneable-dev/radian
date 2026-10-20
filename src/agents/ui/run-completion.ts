import type { RunCompletion } from "../run-completion.ts";

const labels: Record<RunCompletion["outcome"], string> = { complete: "Worked for", error: "Failed after", cancelled: "Cancelled after", unfinished: "Stopped after" };
const localDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const localTime = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

export function formatRunDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return "<1s";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds % 60}s`].filter(Boolean).join(" ");
}

// Epoch timestamps are formatted by the attached UI, not the service's timezone.
export function formatRunCompletion(completion: RunCompletion, timeZone?: string): string {
  const date = timeZone ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }) : localDate;
  const time = timeZone ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }) : localTime;
  return `${labels[completion.outcome]} ${formatRunDuration(completion.durationMs)} • ${date.format(completion.completedAt)} at ${time.format(completion.completedAt)}`.replace(/\s+/g, " ");
}

export function sameRunCompletion(a: RunCompletion | undefined, b: RunCompletion | undefined): boolean {
  return a === b || !!a && !!b && a.startedAt === b.startedAt && a.completedAt === b.completedAt
    && a.durationMs === b.durationMs && a.outcome === b.outcome && a.warning === b.warning;
}
