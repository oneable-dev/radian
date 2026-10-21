import { Type, type Static } from "typebox";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { HistoryError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { parseRunCompletion, runCompletionEntryType } from "./run-completion.ts";

export const dashboardPeriods = [1, 7, 30] as const;
export type DashboardPeriod = typeof dashboardPeriods[number];
export type DashboardCategory = "skills" | "models" | "mcp" | "subagents";
export type DashboardMetric = "tokens" | "runs" | "durationMs";
const count = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const totalsSchema = Type.Object({ tokens: count, runs: count, durationMs: count });
const rankingSchema = Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 512 }), value: count }), { maxItems: 10000 });
export const dashboardSchema = Type.Object({
  days: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(30)]), generatedAt: count,
  totals: totalsSchema,
  daily: Type.Array(Type.Object({ date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), ...totalsSchema.properties }), { minItems: 1, maxItems: 30 }),
  skills: rankingSchema, models: rankingSchema, mcp: rankingSchema, subagents: rankingSchema,
  warnings: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 100 }),
});
export type DashboardSnapshot = Static<typeof dashboardSchema>;
export type DashboardRanking = DashboardSnapshot[DashboardCategory];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const label = (value: string) => value.replace(/[\s\x00-\x1f\x7f-\x9f]+/gu, " ").trim().slice(0, 512);
const blocks = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(object) : [];
const prose = (value: unknown) => typeof value === "string" ? value : blocks(value).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
const xml = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

export function emptyDashboard(days: DashboardPeriod, now = Date.now()): DashboardSnapshot {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(today); date.setDate(date.getDate() - days + index + 1);
    return { date: dashboardDate(date.getTime()), tokens: 0, runs: 0, durationMs: 0 };
  });
  return { days, generatedAt: now, totals: { tokens: 0, runs: 0, durationMs: 0 }, daily, skills: [], models: [], mcp: [], subagents: [], warnings: [] };
}
export function dashboardDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function mergeDashboards(snapshots: readonly DashboardSnapshot[], days: DashboardPeriod, now = Date.now()): DashboardSnapshot {
  const merged = emptyDashboard(days, now);
  for (const snapshot of snapshots) {
    for (const metric of ["tokens", "runs", "durationMs"] as const) merged.totals[metric] += snapshot.totals[metric];
    for (const day of snapshot.daily) {
      const target = merged.daily.find(entry => entry.date === day.date);
      if (target) for (const metric of ["tokens", "runs", "durationMs"] as const) target[metric] += day[metric];
    }
    for (const category of ["skills", "models", "mcp", "subagents"] as const) for (const row of snapshot[category]) {
      const target = merged[category].find(entry => entry.name === row.name);
      if (target) target.value += row.value; else merged[category].push({ ...row });
    }
  }
  for (const category of ["skills", "models", "mcp", "subagents"] as const) merged[category].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  merged.warnings = [...new Set(snapshots.flatMap(snapshot => snapshot.warnings))].slice(0, 100);
  return merged;
}

// Reads raw append-only history, not projected context: compaction/branch changes must not erase usage.
// Entry identities survive SDK forks; shared ancestors are counted once across discovered files.
export class DashboardAccumulator {
  readonly snapshot: DashboardSnapshot;
  readonly identities = new Set<string>();
  private readonly calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  private readonly skills = new Map<string, string>();
  private model = "Unattributed";
  private readonly rankings: Record<DashboardCategory, Map<string, number>> = { skills: new Map(), models: new Map(), mcp: new Map(), subagents: new Map() };
  constructor(days: DashboardPeriod, private readonly cwd: string, private readonly now = Date.now(), private readonly seen: ReadonlySet<string> = new Set()) {
    this.snapshot = emptyDashboard(days, now);
  }
  private warn(message: string): void { if (!this.snapshot.warnings.includes(message)) this.snapshot.warnings.push(message); }
  private increment(category: DashboardCategory, name: string, value = 1): void {
    const normalized = label(name); if (!normalized || !value) return;
    const rows = this.rankings[category]; rows.set(normalized, (rows.get(normalized) ?? 0) + value);
  }
  private day(timestamp: number) { return timestamp <= this.now ? this.snapshot.daily.find(day => day.date === dashboardDate(timestamp)) : undefined; }
  private usage(value: unknown, timestamp: number, model: string): Result<void, HistoryError> {
    if (!object(value) || ![value.input, value.output, value.cacheRead, value.cacheWrite].every(nonnegative))
      return err(new HistoryError("HISTORY_CORRUPT", "Saved token usage is invalid."));
    // Reasoning and 1h cache-write tokens are subsets, not additional consumption.
    const total = Number(value.input) + Number(value.output) + Number(value.cacheRead) + Number(value.cacheWrite);
    const day = this.day(timestamp);
    if (day) { day.tokens += total; this.snapshot.totals.tokens += total; this.increment("models", model, total); }
    return ok(undefined);
  }
  add(value: unknown): Result<void, HistoryError> {
    if (!object(value) || typeof value.type !== "string") return err(new HistoryError("HISTORY_CORRUPT", "Invalid dashboard history entry."));
    if (value.type === "session") return ok(undefined);
    const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || typeof value.id !== "string") return err(new HistoryError("HISTORY_CORRUPT", "Saved history has invalid entry identity or time."));
    const identity = `${value.type}:${value.id}:${value.timestamp}`;
    const fresh = !this.seen.has(identity) && !this.identities.has(identity);
    this.identities.add(identity);
    if (value.type === "model_change" && typeof value.provider === "string" && typeof value.modelId === "string") this.model = `${value.provider}/${value.modelId}`;
    if (value.type === "custom" && value.customType === runCompletionEntryType && fresh) {
      const run = parseRunCompletion(value.data); if (!run.ok) return run;
      const day = this.day(run.value.completedAt);
      if (day) { day.runs++; day.durationMs += run.value.durationMs; this.snapshot.totals.runs++; this.snapshot.totals.durationMs += run.value.durationMs; }
    }
    if (["usage", "compaction", "branch_summary"].includes(value.type) && value.usage !== undefined && fresh) {
      const model = typeof value.provider === "string" && typeof value.model === "string" ? `${value.provider}/${value.model}` : this.model;
      return this.usage(value.usage, timestamp, model);
    }
    if (value.type !== "message") return ok(undefined);
    if (!object(value.message) || typeof value.message.role !== "string") return err(new HistoryError("HISTORY_CORRUPT", "Saved message is invalid."));
    const message = value.message;
    if (message.role === "system") {
      const instructions = object(message.sections) ? prose(message.content) + "\n" + Object.values(message.sections).filter(part => typeof part === "string").join("\n") : prose(message.content);
      for (const match of instructions.matchAll(/<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<location>([^<]+)<\/location>\s*<\/skill>/gu))
        this.skills.set(resolve(this.cwd, xml(match[2]!)), xml(match[1]!));
    }
    if (message.role === "user") {
      const skill = parseSkillBlock(prose(message.content));
      if (skill) { this.skills.set(resolve(this.cwd, skill.location), skill.name); if (fresh && this.day(timestamp)) this.increment("skills", skill.name); }
    }
    if (message.role === "assistant") {
      if (typeof message.provider === "string" && typeof message.model === "string") this.model = `${message.provider}/${message.model}`;
      if (fresh && message.usage !== undefined) { const usage = this.usage(message.usage, timestamp, this.model); if (!usage.ok) return usage; }
      else if (fresh && this.day(timestamp)) this.warn("Some model messages lack token usage and are excluded from token totals.");
      for (const part of blocks(message.content)) if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        const args = object(part.arguments) ? part.arguments : {};
        this.calls.set(part.id, { name: part.name, args });
        if (fresh && this.day(timestamp)) this.subagentCall(part.name, args);
      }
    }
    if (message.role === "toolResult") {
      if (fresh && message.usage !== undefined) { const usage = this.usage(message.usage, timestamp, "Tool work (unattributed)"); if (!usage.ok) return usage; }
      const call = typeof message.toolCallId === "string" ? this.calls.get(message.toolCallId) : undefined;
      if (call?.name === "read" && !message.isError && typeof call.args.path === "string" && /(?:^|[\\/])SKILL\.md$/u.test(call.args.path)) {
        const path = resolve(this.cwd, call.args.path), text = prose(message.content);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
        const name = this.skills.get(path) ?? (frontmatter ? /^name:\s*["']?([a-z0-9]+(?:[-_][a-z0-9]+)*)["']?\s*$/mu.exec(frontmatter[1]!)?.[1] : undefined);
        if (name) { this.skills.set(path, name); if (fresh && this.day(timestamp)) this.increment("skills", name); }
      }
      if (fresh && this.day(timestamp)) {
        const nestedCalls = object(message.nestedCalls) ? blocks(message.nestedCalls.calls) : [];
        const nestedMcp = nestedCalls.filter(nested => typeof nested.name === "string" && nested.name.startsWith("mcp__"));
        // Count underlying calls, never both a gateway wrapper and its nested calls.
        if (nestedMcp.length) for (const nested of nestedMcp) this.mcpCall(String(nested.name), object(nested.arguments) ? nested.arguments : {});
        else if (call) {
          const server = object(message.details) && typeof message.details.server === "string" ? message.details.server : undefined;
          this.mcpCall(call.name, call.args, server);
        }
        for (const nested of nestedCalls) if (typeof nested.name === "string") this.subagentCall(nested.name, object(nested.arguments) ? nested.arguments : {});
        if (object(message.nestedCalls) && message.nestedCalls.complete === false) this.warn("Some nested tool calls have incomplete metadata.");
        if (call?.name === "mcpScript" && !nestedMcp.length) this.warn("Some scripted MCP calls lack stored server metadata and are excluded.");
        if (call?.name === "subagent" && !call.args.action && typeof call.args.agent !== "string") {
          const results = object(message.details) ? blocks(message.details.results) : [];
          let observed = false;
          for (const [index, child] of results.entries()) {
            if (typeof child.agent !== "string" || child.agent === "workflow") continue;
            observed = true;
            const identity = `subagent-run:${typeof child.runId === "string" ? child.runId : `${value.id}:${index}`}`;
            if (!this.seen.has(identity) && !this.identities.has(identity)) this.increment("subagents", child.agent);
            this.identities.add(identity);
          }
          if (!observed) this.warn("Some subagent workflows lack stored child metadata and are excluded.");
        }
      }
    }
    return ok(undefined);
  }
  private mcpCall(name: string, args: Record<string, unknown>, server?: string): void {
    if (name.startsWith("mcp__")) this.increment("mcp", server ?? name.slice(5).split("__")[0]!);
    else if (name === "mcp" && typeof args.tool === "string") {
      if (server || typeof args.server === "string") this.increment("mcp", server ?? String(args.server));
      else if (args.tool.startsWith("mcp__")) this.increment("mcp", args.tool.slice(5).split("__")[0]!);
      else this.warn("Some MCP calls lack stored server metadata and are excluded.");
    }
  }
  private subagentCall(name: string, args: Record<string, unknown>): void {
    if (name === "radian_subagent" && typeof args.name === "string") this.increment("subagents", args.name);
    // Only execution payloads count: list/status/management calls are not agent runs.
    if (name === "subagent" && !args.action) {
      if (typeof args.agent === "string") this.increment("subagents", args.agent);
    }
  }
  finish(): DashboardSnapshot {
    for (const category of ["skills", "models", "mcp", "subagents"] as const)
      this.snapshot[category] = [...this.rankings[category]].filter(([, value]) => value > 0).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    return this.snapshot;
  }
}
