import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Repository, Worktree } from "../workspace/model.ts";
import type { SessionScope } from "./session-scope.ts";
import { repositorySnapshot, type RepositorySource } from "../workspace/catalog.ts";
import type { AgentStatus, Subagent } from "./model.ts";
import {
  AgentRunError,
  CancelledError,
  capture,
  CleanupError,
  collectCleanup,
  HistoryError,
  InputError,
  parseJson,
  SessionError,
  CapabilityError,
  reportUnexpected,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { TranscriptSection } from "./transcript.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import {
  filterCatalog,
  type CompletionCatalog,
  type CompletionItem,
  type CompletionQuery,
  type CompletionResult,
} from "./completion.ts";
import { completeFiles } from "./completion-files.ts";
import { sessionControlCommands } from "./session-controls.ts";
import { summarizeRequest, type RequestSummary } from "./request-summary.ts";
import type { TranscriptImageData } from "./transcript-images.ts";
import {
  modelCommand,
  parseModelCommand,
  type ModelCatalog,
  type ModelEffort,
  type ModelIdentity,
} from "./model-selection.ts";
import { historyCommand, parseHistoryCommand } from "./history-command.ts";
import { dashboardCommand, parseDashboardCommand } from "./dashboard-command.ts";
import { accountsCommand, parseAccountsCommand } from "../accounts/model.ts";
import { needsAttention, type SessionResult } from "./session-attention.ts";
import {
  sessionRecordKey,
  type SessionLifecycle,
  type SessionSnapshotInfo,
} from "./session-snapshot.ts";
import type { ExtensionUiState, ExtensionUiResponse, SessionExtensionUi } from "./extension-ui.ts";
import { SubagentChannel } from "./subagent-channel.ts";
import type { OwnedSubagentRecord } from "./subagent-record.ts";
import type { SubagentCommand, SupervisorCommand } from "./subagent-tools.ts";
import type { SubagentNotice, SubagentNoticePayload } from "./subagent-notifications.ts";
import { validatePlanningProposal, type PlanningProposal } from "./planning-proposal.ts";

export type ExecutionState = {
  readonly conversationId?: string;
  readonly resourceRevision?: number;
  readonly status: AgentStatus | null;
  readonly activity?: "compacting";
  readonly output: string;
  readonly finalOutput?: string;
  readonly activeTools?: readonly string[];
  readonly error: string | null;
  readonly sections?: readonly TranscriptSection[];
  readonly telemetry?: SessionTelemetry;
  readonly request?: RequestSummary;
  readonly result?: SessionResult;
  readonly attention?: SessionResult;
  readonly externalSubagents?: readonly Subagent[];
  readonly pendingMessages?: readonly RequestSummary[];
  readonly runTiming?: { readonly startedAt: number; readonly elapsedMs: number };
};

export type SessionExecutor = {
  readonly savedSessionId: string;
  readonly sessionFile: string | undefined;
  readonly state: ExecutionState;
  readonly extensionUi?: ExtensionUiState | undefined;
  answerExtensionUi?(response: ExtensionUiResponse): Result<void, ExpectedError>;
  setUiActive?(active: boolean): void;
  commands?(): readonly CompletionItem[];
  argumentCompletions?(
    command: string,
    prefix: string,
    signal?: AbortSignal,
  ): Promise<Result<CompletionResult, ExpectedError>>;
  reload?(): Promise<Result<void, ExpectedError>>;
  models?(signal?: AbortSignal, refresh?: boolean): Promise<Result<ModelCatalog, ExpectedError>>;
  selectModel?(
    model: ModelIdentity,
    effort?: ModelEffort,
  ): Promise<Result<string | null, ExpectedError>>;
  imageData?(id: string): Result<TranscriptImageData, ExpectedError>;
  readonly acceptsImages?: boolean;
  readonly busy?: boolean;
  compact?(instructions?: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>>;
  interrupt?(onAccepted?: () => void): Promise<Result<void, ExpectedError>>;
  subscribe(listener: () => void): () => void;
  // Resolves on run completion; the optional callback marks SDK input acceptance.
  prompt(
    text: string,
    onAccepted?: () => void,
    imagePaths?: readonly string[],
  ): Promise<Result<void, ExpectedError>>;
  notifySubagent?(event: SubagentNotice, current?: () => boolean): void;
  steer?(message: string): Promise<Result<unknown, ExpectedError>>;
  beforeNewSession?(): Promise<Result<void, ExpectedError>>;
  close(reason?: "quit" | "new"): Promise<Result<void, ExpectedError>>;
};

export type SessionContext = {
  readonly cwd: string;
  readonly scope?: SessionScope;
  readonly worktreeId?: string;
  readonly sessionFile?: string;
  readonly previousSessionFile?: string;
  readonly startReason?: "new";
  readonly role: "main" | "subagent";
  readonly agent?: string;
  readonly purpose?: "planning";
  coordinateSubagents?(
    command: SubagentCommand,
    signal?: AbortSignal,
    purpose?: "planning",
  ): Promise<Result<unknown, ExpectedError>>;
  contactSupervisor?(
    command: SupervisorCommand,
    signal?: AbortSignal,
  ): Promise<Result<unknown, ExpectedError>>;
  isUiActive?: () => boolean;
  spawnSubagent(
    name: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<Result<string, ExpectedError>>;
};

export type SessionRecord = {
  readonly id: string;
  readonly name: string;
  readonly scope?: SessionScope;
  readonly role?: "subagent";
  readonly worktreeId?: string;
  readonly sessionFile?: string;
  readonly state: ExecutionState;
  readonly subagents: readonly Subagent[];
  readonly ownedSubagents?: readonly OwnedSubagentRecord[];
  readonly lifecycle?: SessionLifecycle;
  readonly updatedAt?: number;
  readonly cwd?: string;
  readonly closedAt?: number | null;
  readonly managed?: boolean;
};

// Creation is an exception-based SDK boundary. The registry converts only classified failures.
export type SessionFactory = (context: SessionContext) => Promise<SessionExecutor>;

type Execution = {
  readonly id: string;
  readonly name: string;
  readonly role: "main" | "subagent";
  readonly purpose?: "planning";
  planningProposal?: PlanningProposal;
  ready: Promise<Result<SessionExecutor, ExpectedError>> | undefined;
  finishedStatus?: AgentStatus | null;
  fileKey?: string;
  executor?: SessionExecutor;
  unsubscribe?: () => void;
  cleanupTask?: Promise<Result<void, ExpectedError>>;
  failure?: string;
  request?: RequestSummary;
  runTiming?: Subagent["runTiming"];
  task?: string;
  output?: string;
  finalOutput?: string;
  noticeVersion?: number;
  observedNoticeVersion?: number;
  terminalObserved?: boolean;
  progress?: OwnedSubagentRecord["progress"];
  suppressNotifications?: boolean;
  backgroundAccepted?: boolean;
  channel?: SubagentChannel;
  completion?: Promise<Result<string, ExpectedError>>;
  settled?: boolean;
  controller?: AbortController;
  readonly worktree?: Worktree | undefined;
  readonly managed?: boolean;
  closedAt?: number;
};

type OpenExecution = Execution & {
  closeTask?: Promise<Result<void, ExpectedError>>;
  readonly scope: SessionScope;
  readonly worktree?: Worktree | undefined;
  readonly children: Map<string, Execution>;
  readonly generation: string;
  phase: "creating" | "open" | "closing";
  recoveredState?: ExecutionState;
  replacing?: boolean;
  observedResultId?: string | undefined;
  attention?: SessionResult | undefined;
  hiddenChildren?: Set<string>;
  childrenSettledAt?: number;
  childrenTimer?: ReturnType<typeof setTimeout>;
};

export class SessionRegistry {
  private readonly entries = new Map<string, OpenExecution>();
  private readonly listeners = new Set<() => void>();
  private readonly fileOwners = new Map<string, string>();
  private readonly retired = new Map<string, SessionRecord>();
  private shuttingDown = false;
  private uiActive = false;
  private readonly replacements = new Set<Promise<Result<void, ExpectedError>>>();

  constructor(
    private readonly repositories: RepositorySource,
    private readonly factory: SessionFactory,
    private readonly registryScope: "code" | "chat" = "code",
  ) {}

  setUiActive(active: boolean): void {
    this.uiActive = active;
    for (const entry of this.entries.values()) {
      entry.executor?.setUiActive?.(active);
    }
  }

  get extensionUi(): SessionExtensionUi[] {
    return [...this.entries.values()].flatMap((entry) => {
      const state = entry.phase === "open" ? entry.executor?.extensionUi : undefined;

      return state &&
        (state.dialog ||
          state.notifications.length ||
          Object.keys(state.statuses).length ||
          state.mcp)
        ? [{ sessionId: entry.id, conversationId: entry.executor!.savedSessionId, ...state }]
        : [];
    });
  }

  answerExtensionUi(
    id: string,
    conversationId: string,
    response: ExtensionUiResponse,
  ): Result<void, ExpectedError> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }

    const entry = selected.value;
    if (entry.replacing || entry.executor?.savedSessionId !== conversationId) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "This tab changed conversations. No extension answer was delivered.",
        ),
      );
    }

    return (
      entry.executor?.answerExtensionUi?.(response) ??
      err(new CapabilityError("This session does not host extension dialogs."))
    );
  }

  get retainedWorktreeIds(): ReadonlySet<string> {
    return new Set(
      [...this.entries.values()].flatMap((entry) =>
        entry.scope.kind === "code" ? [entry.scope.worktreeId] : [],
      ),
    );
  }

  get snapshot(): readonly Repository[] {
    return repositorySnapshot(this.repositories).map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((worktree) => ({
        ...worktree,
        sessions: [...this.entries.values()]
          .filter(
            (entry) =>
              entry.phase === "open" &&
              entry.scope.kind === "code" &&
              entry.scope.worktreeId === worktree.id,
          )
          .map((entry) => {
            const state = this.details(entry.id);

            return {
              id: entry.id,
              name: entry.name,
              status: state?.status ?? null,
              subagents:
                entry.childrenSettledAt !== undefined &&
                Date.now() >= entry.childrenSettledAt + 10_000
                  ? []
                  : this.children(entry).filter((child) => !entry.hiddenChildren?.has(child.id)),
              ...(state?.request ? { request: state.request } : {}),
              ...(state?.result ? { result: state.result } : {}),
              ...(entry.attention ? { attention: entry.attention } : {}),
            };
          }),
      })),
    }));
  }

  get chatSessions(): readonly Repository["worktrees"][number]["sessions"][number][] {
    return [...this.entries.values()]
      .filter((entry) => entry.phase === "open" && entry.scope.kind === "chat")
      .map((entry) => {
        const state = this.details(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          status: state?.status ?? null,
          subagents: this.children(entry),
          ...(state?.request ? { request: state.request } : {}),
          ...(state?.result ? { result: state.result } : {}),
          ...(entry.attention ? { attention: entry.attention } : {}),
        };
      });
  }

  get closingCount(): number {
    return [...this.entries.values()].filter((entry) => entry.phase === "closing").length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  details(id: string): ExecutionState | null {
    const entry = this.entries.get(id);
    if (entry?.phase !== "open") {
      return null;
    }

    const live = entry.executor?.state;
    // Recovery keeps transcript/status history, but account usage continues updating in the live SDK.
    const state = entry.recoveredState
      ? {
          ...entry.recoveredState,
          ...(live?.conversationId ? { conversationId: live.conversationId } : {}),
          ...(live?.resourceRevision !== undefined
            ? { resourceRevision: live.resourceRevision }
            : {}),
          ...(live?.telemetry ? { telemetry: live.telemetry } : {}),
        }
      : live;
    if (!state) {
      return null;
    }

    // Replacement guards input admission; it must not invent model activity for /clear.
    return entry.attention ? { ...state, attention: entry.attention } : state;
  }

  acknowledge(id: string, conversationId: string, resultId: string): Result<void, ExpectedError> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }

    const entry = selected.value;
    if (entry.replacing || entry.executor!.savedSessionId !== conversationId) {
      return err(
        new SessionError("SESSION_CONFLICT", "Conversation changed. No result was acknowledged."),
      );
    }
    // A delayed acknowledgement must never clear a newer result. Repeated acknowledgements are safe.
    if (entry.attention?.id === resultId) {
      delete entry.attention;
      this.emit();
    }

    return ok(undefined);
  }

  private executionChanged(entry: OpenExecution): void {
    if (entry.phase !== "open") {
      return;
    }

    const result = entry.executor?.state.result;
    if (result && result.id !== entry.observedResultId) {
      entry.observedResultId = result.id;
      if (needsAttention(result)) {
        entry.attention = result;
      }
    }

    this.emit();
  }

  sessionFile(id: string): string | undefined {
    return this.entries.get(id)?.executor?.sessionFile;
  }

  imageData(sessionId: string, imageId: string): Result<TranscriptImageData, ExpectedError> {
    const entry = this.requireOpen(sessionId);
    if (!entry.ok) {
      return entry;
    }
    if (entry.value.replacing) {
      return err(new SessionError("SESSION_BUSY", "This tab is changing conversations."));
    }

    const executor = entry.value.executor;

    return executor?.imageData
      ? executor.imageData(imageId)
      : err(new CapabilityError("This session does not provide image previews."));
  }

  historyOwnership(canonicalFile: string): {
    openSessionId: string | null;
    unavailableReason: string | null;
  } {
    const owner = this.fileOwners.get(canonicalFile);
    if (!owner) {
      return { openSessionId: null, unavailableReason: null };
    }
    if (owner.startsWith("retention:")) {
      return { openSessionId: null, unavailableReason: "Saved session cleanup is in progress." };
    }

    const entry = this.entries.get(owner);
    if (entry?.replacing) {
      return {
        openSessionId: null,
        unavailableReason: "Saved session is being replaced. Wait for cleanup to finish.",
      };
    }
    if (entry?.phase === "open") {
      return { openSessionId: entry.id, unavailableReason: null };
    }

    return {
      openSessionId: null,
      unavailableReason: !entry
        ? "Saved session belongs to an active subagent."
        : entry.phase === "creating"
          ? "Saved session is being opened. Try again shortly."
          : "Session is still closing. Try again after cleanup.",
    };
  }

  reserveSnapshotCleanup(
    snapshot: SessionSnapshotInfo,
    canonicalFile?: string,
  ): (() => void) | null {
    if (this.shuttingDown) {
      return null;
    }

    const current = this.sessionSnapshot(
      snapshot.scope?.kind === "chat" ? undefined : snapshot.worktreeId,
      snapshot.conversationId ?? snapshot.id,
    );
    if (current && (current.lifecycle !== "closed" || current.closedAt !== snapshot.closedAt)) {
      return null;
    }
    if (canonicalFile && this.fileOwners.has(canonicalFile)) {
      return null;
    }

    const token = `retention:${crypto.randomUUID()}`;
    if (canonicalFile) {
      this.fileOwners.set(canonicalFile, token);
    }

    return () => {
      if (canonicalFile && this.fileOwners.get(canonicalFile) === token) {
        this.fileOwners.delete(canonicalFile);
      }
    };
  }

  get records(): readonly SessionRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.phase === "open")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(entry.scope.kind === "code"
          ? { worktreeId: entry.scope.worktreeId }
          : { scope: entry.scope }),
        ...(entry.fileKey
          ? { sessionFile: entry.fileKey }
          : entry.executor?.sessionFile
            ? { sessionFile: entry.executor.sessionFile }
            : {}),
        state: {
          ...(this.details(entry.id) ?? { status: null, output: "", error: null }),
          conversationId: entry.executor!.savedSessionId,
        },
        subagents: this.children(entry),
        ownedSubagents: this.ownedRecords(entry),
        lifecycle: "open",
        closedAt: null,
        managed: entry.managed ?? false,
        cwd: entry.worktree?.path ?? homedir(),
      }));
  }

  sessionSnapshot(
    worktreeId: string | undefined,
    conversationId: string,
  ): SessionRecord | undefined {
    return (
      this.records.find(
        (record) =>
          record.worktreeId === worktreeId && record.state.conversationId === conversationId,
      ) ??
      [...this.retired.values()].find(
        (record) =>
          record.worktreeId === worktreeId && record.state.conversationId === conversationId,
      )
    );
  }

  // Retain closed records only until the shared store confirms persistence.
  get checkpointRecords(): readonly SessionRecord[] {
    return [...this.retired.values(), ...this.records];
  }

  acknowledgeCheckpoint(records: readonly SessionRecord[]): void {
    for (const record of records) {
      if (this.retired.get(sessionRecordKey(record)) === record) {
        this.retired.delete(sessionRecordKey(record));
      }
    }
  }

  private retire(entry: OpenExecution, before?: SessionRecord): SessionRecord | undefined {
    if (!entry.executor) return undefined;
    const record = {
      ...this.retireExecution(
        entry,
        entry.scope,
        entry.worktree,
        this.children(entry),
        entry.executor,
        before,
      ),
      ownedSubagents: this.ownedRecords(entry),
    };
    this.retired.set(sessionRecordKey(record), record);
    return record;
  }

  private ownedRecords(entry: OpenExecution): OwnedSubagentRecord[] {
    const expired =
      entry.childrenSettledAt !== undefined && Date.now() >= entry.childrenSettledAt + 10_000;
    return [...entry.children.values()].map((child) => {
      const state = child.executor?.state;
      const runTiming = state?.runTiming ?? child.runTiming;
      const finalOutput = state?.finalOutput ?? child.finalOutput;
      return {
        id: child.id,
        name: child.name,
        status: child.failure ? "failure" : (state?.status ?? child.finishedStatus ?? null),
        ...(child.task !== undefined ? { task: child.task } : {}),
        output: state?.output ?? child.output ?? "",
        ...(finalOutput !== undefined ? { finalOutput } : {}),
        ...(child.failure ? { error: child.failure } : {}),
        ...(child.fileKey ? { sessionFile: child.fileKey } : {}),
        ...(child.closedAt !== undefined ? { finishedAt: child.closedAt } : {}),
        hidden: expired || entry.hiddenChildren?.has(child.id) === true,
        ...(child.request ? { request: child.request } : {}),
        ...(runTiming ? { runTiming } : {}),
        progress: [...(child.channel?.progress ?? child.progress ?? [])],
      };
    });
  }

  private retireExecution(
    entry: Execution,
    scope: SessionScope,
    worktree: Worktree | undefined,
    subagents: readonly Subagent[],
    executor: SessionExecutor,
    before?: SessionRecord,
  ): SessionRecord {
    const state = executor.state;
    const sessionFile = entry.fileKey ?? executor.sessionFile;
    const telemetry = before?.state.telemetry ?? state.telemetry;
    const interrupted = state.status === "working";
    const record: SessionRecord = {
      id: entry.id,
      name: entry.name,
      ...(scope.kind === "code" ? { worktreeId: scope.worktreeId } : { scope }),
      ...(scope.kind === "chat" && entry.role === "subagent" ? { role: "subagent" as const } : {}),
      cwd: worktree?.path ?? homedir(),
      ...(sessionFile ? { sessionFile } : {}),
      lifecycle: "closed",
      closedAt: entry.closedAt ?? before?.closedAt ?? Date.now(),
      managed: entry.managed ?? false,
      updatedAt: Date.now(),
      state: {
        ...state,
        conversationId: executor.savedSessionId,
        ...(telemetry ? { telemetry } : {}),
        ...(interrupted
          ? {
              status: null,
              pendingMessages: [],
              result: { id: crypto.randomUUID(), outcome: "unfinished", completedAt: Date.now() },
            }
          : {}),
      },
      subagents,
    };

    this.retired.set(sessionRecordKey(record), record);

    return record;
  }

  private children(entry: OpenExecution): Subagent[] {
    const owned = [...entry.children.values()].map((child): Subagent => {
      const state = child.executor?.state;
      const request = state?.request ?? child.request;
      const runTiming = state?.runTiming ?? child.runTiming;
      const progress = (child.channel?.progress ?? child.progress)?.at(-1)?.message;

      return {
        id: child.id,
        name: child.name,
        ...(progress ? { progress: progress.slice(0, 512) } : {}),
        status: child.failure
          ? "failure"
          : (state?.status ?? child.finishedStatus ?? (child.ready ? "working" : null)),
        ...(child.channel?.questions.length ? { phase: "waiting" as const } : {}),
        ...(child.closedAt !== undefined ? { finishedAt: child.closedAt } : {}),
        ...(request ? { request } : {}),
        ...(runTiming ? { runTiming } : {}),
      };
    });

    // Pi extension children are display observations, never handles owned by this registry.
    return [...owned, ...(entry.executor?.state.externalSubagents ?? [])];
  }

  async restore(record: SessionRecord): Promise<Result<void, ExpectedError>> {
    if (record.lifecycle === "closed" || record.role === "subagent") {
      return ok(undefined);
    }

    const existence = await capture(async () =>
      record.sessionFile ? Bun.file(record.sessionFile).exists() : false,
    );
    if (!existence.ok) {
      return existence;
    }
    if (!existence.value && record.state.output) {
      return err(
        new HistoryError(
          "HISTORY_UNAVAILABLE",
          "Saved conversation file is missing; refusing to replace it with an empty session.",
        ),
      );
    }
    if (existence.value && record.sessionFile) {
      const validated = await validateHistory(record.sessionFile);
      if (!validated.ok) {
        return validated;
      }
    }

    const created = await this.createScoped(
      record.scope?.kind === "chat"
        ? { kind: "chat" }
        : { kind: "code", worktreeId: record.worktreeId! },
      existence.value ? record.sessionFile : undefined,
      record,
    );
    if (!created.ok) {
      return created;
    }

    const selected = this.requireOpen(record.id);
    if (!selected.ok) {
      return selected;
    }

    const entry = selected.value;
    const restored = entry.executor!.state;
    const interrupted: SessionResult | undefined =
      record.state.status === "working" ||
      record.ownedSubagents?.some((child) => child.status === "working") ||
      record.subagents.some((child) => child.source !== "pi" && child.status === "working")
        ? {
            id: crypto.randomUUID(),
            outcome: "unfinished",
            completedAt: Date.now(),
            ...(record.state.request ? { request: record.state.request } : {}),
          }
        : undefined;

    entry.attention = interrupted ?? record.state.attention;
    entry.recoveredState = {
      ...((record.state.request ?? restored.request)
        ? { request: record.state.request ?? restored.request }
        : {}),
      ...((interrupted ?? record.state.result)
        ? { result: interrupted ?? record.state.result }
        : {}),
      output:
        restored.output.length >= record.state.output.length
          ? restored.output
          : record.state.output,
      ...(restored.sections
        ? { sections: restored.sections }
        : record.state.sections
          ? { sections: record.state.sections }
          : {}),
      // Recompute telemetry from the SDK and explicit conversation preferences, never cached quotas.
      ...(restored.telemetry ? { telemetry: restored.telemetry } : {}),
      status: interrupted ? null : restored.status,
      error: interrupted
        ? "Previous runtime ended during owned work; inspect saved results and submit a new prompt to continue."
        : restored.error,
    };
    for (const child of record.ownedSubagents ??
      record.subagents.filter((child) => child.source !== "pi")) {
      const saved = "output" in child ? child : undefined;
      if (saved?.hidden) {
        entry.hiddenChildren ??= new Set();
        entry.hiddenChildren.add(child.id);
      }
      entry.children.set(child.id, {
        ...(saved
          ? {
              output: saved.output,
              ...(saved.finalOutput !== undefined ? { finalOutput: saved.finalOutput } : {}),
              progress: saved.progress,
              ...(saved.task !== undefined ? { task: saved.task } : {}),
              ...(saved.sessionFile ? { fileKey: saved.sessionFile } : {}),
              ...(saved.error ? { failure: saved.error } : {}),
            }
          : {}),
        id: child.id,
        name: child.name,
        role: "subagent",
        ready: undefined,
        ...(child.request ? { request: child.request } : {}),
        ...(child.runTiming ? { runTiming: child.runTiming } : {}),
        closedAt: child.finishedAt ?? record.updatedAt ?? Date.now(),
        finishedStatus: child.status === "working" ? null : child.status,
      });
    }

    this.emit();

    return ok(undefined);
  }

  create(
    worktreeId: string,
    sessionFile?: string,
    identity?: { readonly id: string; readonly name: string; readonly managed?: boolean },
  ): Promise<Result<string, ExpectedError>> {
    return this.createScoped({ kind: "code", worktreeId }, sessionFile, identity);
  }

  createChat(
    sessionFile?: string,
    identity?: { readonly id: string; readonly name: string; readonly managed?: boolean },
  ): Promise<Result<string, ExpectedError>> {
    return this.createScoped({ kind: "chat" }, sessionFile, identity);
  }

  private async createScoped(
    scope: SessionScope,
    sessionFile?: string,
    identity?: { readonly id: string; readonly name: string; readonly managed?: boolean },
  ): Promise<Result<string, ExpectedError>> {
    if (scope.kind !== this.registryScope) {
      return err(new InputError("Session scope does not belong to this registry."));
    }
    if (this.shuttingDown) {
      return err(this.stopping());
    }

    const worktree =
      scope.kind === "code"
        ? repositorySnapshot(this.repositories)
            .flatMap((repo) => repo.worktrees)
            .find((tree) => tree.id === scope.worktreeId)
        : undefined;
    if (scope.kind === "code" && !worktree) {
      return err(new InputError(`Unknown worktree: ${scope.worktreeId}`));
    }

    const canonical = sessionFile ? await capture(() => realpath(sessionFile)) : ok(undefined);
    if (!canonical.ok) {
      return canonical;
    }
    if (this.shuttingDown) {
      return err(this.stopping());
    }

    const requestedFile = canonical.value;
    if (requestedFile && this.fileOwners.has(requestedFile)) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "This saved session is already open or still closing.",
        ),
      );
    }

    const id = identity?.id ?? crypto.randomUUID();
    if (this.entries.has(id)) {
      return err(new SessionError("SESSION_CONFLICT", "This open-session ID already exists."));
    }
    if (requestedFile) {
      this.fileOwners.set(requestedFile, id);
    }

    const generation = crypto.randomUUID();
    const ready = capture(() =>
      this.factory({
        cwd: worktree?.path ?? homedir(),
        scope,
        ...(scope.kind === "code" ? { worktreeId: scope.worktreeId } : {}),
        role: "main",
        isUiActive: () => this.uiActive,
        ...(requestedFile ? { sessionFile: requestedFile } : {}),
        spawnSubagent: (name, task, signal) =>
          this.spawnSubagent(id, name, task, signal, generation),
        coordinateSubagents: (command, signal, purpose) =>
          this.coordinateSubagents(id, generation, command, signal, purpose),
      }),
    );
    const entry: OpenExecution = {
      id,
      name: identity?.name ?? `Session ${id.slice(0, 8)}`,
      role: "main",
      scope,
      ...(worktree ? { worktree } : {}),
      ready,
      generation,
      phase: "creating",
      children: new Map(),
      managed: identity?.managed ?? !requestedFile,
      ...(requestedFile ? { fileKey: requestedFile } : {}),
    };

    this.entries.set(id, entry);

    let result: Result<string, ExpectedError>;
    try {
      result = await this.initialize(entry, ready, requestedFile);
    } catch (error) {
      // Unexpected bugs still need cleanup; preserve both the original and any cleanup exception.
      if (entry.phase === "creating" && !entry.executor) {
        this.entries.delete(id);
        if (entry.fileKey && this.fileOwners.get(entry.fileKey) === id) {
          this.fileOwners.delete(entry.fileKey);
        }
      } else if (entry.phase === "creating") {
        try {
          const cleanup = await this.close(id);
          if (!cleanup.ok) {
            throw cleanup.error;
          }
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Creation and cleanup failed.");
        }
      }

      throw error;
    }
    if (!result.ok && entry.phase === "creating") {
      const cleanup = await this.close(id);
      if (!cleanup.ok) {
        return err(new CleanupError("Creation and cleanup failed.", [result.error, cleanup.error]));
      }
    }

    return result;
  }

  private async initialize(
    entry: OpenExecution,
    ready: NonNullable<Execution["ready"]>,
    requestedFile?: string,
  ): Promise<Result<string, ExpectedError>> {
    const created = await ready;
    if (!created.ok) {
      return created;
    }

    entry.executor = created.value;

    const key = await capture(() => this.fileKey(created.value));
    if (!key.ok) {
      return key;
    }
    if (entry.phase !== "creating") {
      return err(new CancelledError("Session creation was cancelled by shutdown."));
    }
    if (requestedFile && key.value !== requestedFile) {
      throw new Error("Executor did not reopen the requested saved session.");
    }
    if (key.value) {
      const owner = this.fileOwners.get(key.value);
      if (owner && owner !== entry.id) {
        return err(
          new SessionError(
            "SESSION_CONFLICT",
            "This saved session is already open or still closing.",
          ),
        );
      }

      entry.fileKey = key.value;
      this.fileOwners.set(key.value, entry.id);
    }

    // Opening History and upgrading old manifests establishes a baseline, not a new notification.
    entry.observedResultId = created.value.state.result?.id;
    entry.unsubscribe = created.value.subscribe(() => this.executionChanged(entry));
    entry.phase = "open";
    this.emit();

    return ok(entry.id);
  }

  async complete(
    id: string,
    query: CompletionQuery,
    signal?: AbortSignal,
  ): Promise<Result<CompletionResult, ExpectedError>> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }

    const entry = selected.value;
    if (query.kind === "argument") {
      if (!query.command)
        return err(new InputError("Argument completion requires a command name."));
      const result =
        (await entry.executor?.argumentCompletions?.(query.command, query.query, signal)) ??
        ok({ items: [], truncated: false });
      return entry.phase === "open"
        ? result
        : err(new SessionError("SESSION_NOT_OPEN", "Session closed during argument completion."));
    }
    if (query.kind === "file") {
      if (entry.scope.kind === "chat") {
        return err(new CapabilityError("CHAT does not index or complete project files."));
      }
      const result = await completeFiles(entry.worktree!.path, query.query, signal);

      return entry.phase === "open"
        ? result
        : err(new SessionError("SESSION_NOT_OPEN", "Session closed during file discovery."));
    }

    const catalog = this.catalog(id, entry.executor!.savedSessionId);

    return catalog.ok ? ok(filterCatalog(catalog.value.items, query)) : catalog;
  }

  catalog(id: string, conversationId: string): Result<CompletionCatalog, ExpectedError> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }

    const entry = selected.value;
    if (entry.replacing || entry.executor?.savedSessionId !== conversationId) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "Conversation changed while loading completion resources.",
        ),
      );
    }

    const executor = entry.executor!;
    const controls = [
      ...sessionControlCommands.filter((item) => {
        if (item.value === "compact") {
          return !!executor.compact;
        } else if (item.value === "reload") {
          return !!executor.reload;
        } else {
          return true;
        }
      }),
      ...(executor.models && executor.selectModel ? [modelCommand] : []),
      historyCommand,
      dashboardCommand,
      accountsCommand,
    ];
    const extra = executor.commands?.() ?? [];

    return ok({
      conversationId,
      revision: executor.state.resourceRevision ?? 0,
      items: [
        ...controls,
        ...extra.filter((item) => !controls.some((control) => control.value === item.value)),
      ],
    });
  }

  reload(id: string): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return Promise.resolve(selected);
    }

    const entry = selected.value;
    if (
      entry.replacing ||
      [...entry.children.values()].some(
        (child) =>
          child.executor?.busy ||
          child.executor?.state.status === "working" ||
          (child.ready && !child.executor),
      )
    ) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for this conversation and its owned work before reloading resources.",
          ),
        ),
      );
    }

    return entry.executor?.reload
      ? entry.executor.reload()
      : Promise.resolve(
          err(new CapabilityError("This executor does not support resource reload.")),
        );
  }

  async models(
    id: string,
    conversationId: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<Result<ModelCatalog, ExpectedError>> {
    const selected = this.modelOwner(id, conversationId);
    if (!selected.ok) {
      return selected;
    }

    const executor = selected.value.executor;
    if (!executor?.models) {
      return err(new CapabilityError("This executor does not support model selection."));
    }

    const result = await executor.models(signal, refresh);
    const current = this.modelOwner(id, conversationId);
    if (!current.ok) {
      return current;
    }

    return signal?.aborted ? err(new CancelledError()) : result;
  }

  async selectModel(
    id: string,
    conversationId: string,
    model: ModelIdentity,
    effort?: ModelEffort,
  ): Promise<Result<string | null, ExpectedError>> {
    const selected = this.modelOwner(id, conversationId);
    if (!selected.ok) {
      return selected;
    }

    const executor = selected.value.executor;
    if (!executor?.selectModel) {
      return err(new CapabilityError("This executor does not support model selection."));
    }

    return executor.selectModel(model, effort);
  }

  private modelOwner(id: string, conversationId: string): Result<OpenExecution, ExpectedError> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }
    if (selected.value.replacing) {
      return err(new SessionError("SESSION_BUSY", "This tab is changing conversations."));
    }
    if (selected.value.executor?.savedSessionId !== conversationId) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "This tab changed conversations. Reopen /model before selecting a model.",
        ),
      );
    }

    return selected;
  }

  async prompt(
    id: string,
    text: string,
    onAccepted?: () => void,
    imagePaths: readonly string[] = [],
  ): Promise<Result<void, ExpectedError>> {
    const dashboard = parseDashboardCommand(text);
    if (!dashboard.ok) {
      return dashboard;
    }
    if (dashboard.value) {
      return err(
        new CapabilityError(
          "Use /dashboard in the Agent input to open usage statistics. No model prompt was sent.",
        ),
      );
    }

    const history = parseHistoryCommand(text);
    if (!history.ok) {
      return history;
    }
    if (history.value) {
      return err(
        new CapabilityError(
          "Use /history in the Agent input to open saved session history. No model prompt was sent.",
        ),
      );
    }

    const accounts = parseAccountsCommand(text);
    if (!accounts.ok) {
      return accounts;
    }
    if (accounts.value) {
      return err(
        new CapabilityError(
          "Use /accounts in the Agent input to manage accounts. No model prompt was sent.",
        ),
      );
    }

    const model = parseModelCommand(text);
    if (!model.ok) {
      return model;
    }
    if (model.value) {
      return err(
        new CapabilityError(
          "Use /model in the Agent input to open the model picker. No model prompt was sent.",
        ),
      );
    }

    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return selected;
    }
    if (selected.value.replacing) {
      return err(
        new SessionError("SESSION_BUSY", "This tab is changing sessions. Input was retained."),
      );
    }
    if (!text.trim()) {
      return err(new InputError("A prompt must not be empty."));
    }
    if (imagePaths.length && !selected.value.executor?.acceptsImages) {
      return err(
        new CapabilityError(
          "The selected model does not accept image input. Switch models or remove the image; input was retained.",
        ),
      );
    }

    const entry = selected.value;
    let accepted = false;
    const accept = () => {
      if (accepted) {
        return;
      }

      accepted = true;
      if (entry.recoveredState) {
        delete entry.recoveredState;
        this.emit();
      }

      onAccepted?.();
    };
    const result = await entry.executor!.prompt(
      text,
      accept,
      imagePaths.map((path) => resolve(entry.worktree?.path ?? homedir(), path)),
    );
    // Executors without an admission callback can prove acceptance only on success.
    if (result.ok && !accepted) {
      accept();
    }

    return result;
  }

  compact(
    id: string,
    instructions?: string,
    onAccepted?: () => void,
  ): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return Promise.resolve(selected);
    }

    const entry = selected.value;
    if (entry.replacing) {
      return Promise.resolve(
        err(new SessionError("SESSION_BUSY", "This tab is changing sessions.")),
      );
    }
    if (
      [...entry.children.values()].some(
        (child) =>
          child.executor?.busy ||
          child.executor?.state.status === "working" ||
          (child.ready && !child.executor),
      )
    ) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for this session's owned work to finish before compacting.",
          ),
        ),
      );
    }
    if (!entry.executor?.compact) {
      return Promise.resolve(
        err(new CapabilityError("This executor does not support manual compaction.")),
      );
    }

    return entry.executor.compact(instructions, () => {
      delete entry.recoveredState;
      onAccepted?.();
    });
  }

  interrupt(id: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return Promise.resolve(selected);
    }

    const entry = selected.value;
    if (entry.replacing) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "This tab is changing sessions. No interrupt was accepted.",
          ),
        ),
      );
    }
    if (!entry.executor?.interrupt) {
      return Promise.resolve(
        err(new CapabilityError("This executor does not support interruption.")),
      );
    }

    for (const child of entry.children.values()) child.suppressNotifications = true;
    return collectCleanup(
      [
        entry.executor.interrupt(onAccepted),
        ...[...entry.children.values()].map((child) => this.closeExecution(child)),
      ],
      "Could not interrupt all owned work.",
    );
  }

  newTab(id: string): Promise<Result<string, ExpectedError>> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return Promise.resolve(selected);
    }
    if (selected.value.replacing) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "This tab is changing conversations. No new tab was created.",
          ),
        ),
      );
    }

    const scope = selected.value.scope;
    return scope.kind === "chat" ? this.createChat() : this.create(scope.worktreeId);
  }

  clearSession(id: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(id);
    if (!selected.ok) {
      return Promise.resolve(selected);
    }

    const previous = selected.value;
    if (previous.replacing) {
      return Promise.resolve(
        err(new SessionError("SESSION_BUSY", "This tab is already changing sessions.")),
      );
    }

    previous.replacing = true;
    this.emit();

    const task = this.replaceSession(previous, onAccepted).finally(() => {
      previous.replacing = false;
      this.replacements.delete(task);
      this.emit();
    });
    this.replacements.add(task);

    return task;
  }

  private async replaceSession(
    previous: OpenExecution,
    onAccepted?: () => void,
  ): Promise<Result<void, ExpectedError>> {
    // Prepare a distinct SDK conversation before interrupting the old one. A
    // failed factory must not discard a working tab or its on-disk history.
    const allowed = await previous.executor?.beforeNewSession?.();
    if (allowed && !allowed.ok) {
      return allowed;
    }
    if (this.shuttingDown || previous.phase !== "open") {
      return err(new CancelledError("Session replacement was cancelled by shutdown."));
    }

    const generation = crypto.randomUUID();
    const previousSessionFile = previous.executor?.sessionFile;
    const ready = capture(() =>
      this.factory({
        cwd: previous.worktree?.path ?? homedir(),
        scope: previous.scope,
        ...(previous.scope.kind === "code" ? { worktreeId: previous.scope.worktreeId } : {}),
        role: "main",
        isUiActive: () => this.uiActive,
        startReason: "new",
        ...(previousSessionFile ? { previousSessionFile } : {}),
        spawnSubagent: (name, task, signal) =>
          this.spawnSubagent(previous.id, name, task, signal, generation),
        coordinateSubagents: (command, signal, purpose) =>
          this.coordinateSubagents(previous.id, generation, command, signal, purpose),
      }),
    );
    const created = await ready;
    if (!created.ok) {
      return created;
    }

    const next = created.value;
    let stopping = false;
    let adopted = false;
    let result: Result<void, ExpectedError>;
    try {
      const key = await capture(() => this.fileKey(next));
      if (!key.ok) {
        result = key;
      } else if (
        next.savedSessionId === previous.executor?.savedSessionId ||
        (key.value && this.fileOwners.has(key.value))
      ) {
        result = err(
          new SessionError(
            "SESSION_CONFLICT",
            "Replacement did not create a distinct conversation.",
          ),
        );
      } else if (this.shuttingDown || previous.phase !== "open") {
        result = err(new CancelledError("Session replacement was cancelled by shutdown."));
      } else {
        onAccepted?.();
        stopping = true;
        previous.closedAt = Date.now();
        if (previous.childrenTimer) clearTimeout(previous.childrenTimer);

        const archived = this.retire(previous);
        // Explicit /clear stops only the execution owned by this tab. Keep its file
        // fenced until all parent/child tool results have settled and persisted.
        const stopped = await collectCleanup(
          [
            this.closeExecution(previous, "new"),
            ...[...previous.children.values()].map((child) => this.closeExecution(child, "new")),
          ],
          "Could not finish the previous conversation.",
        );
        if (!stopped.ok) {
          previous.recoveredState = {
            ...previous.executor!.state,
            status: "failure",
            error:
              "Session replacement could not confirm cleanup of the previous conversation. Inspect the cleanup error before retrying.",
          };
          result = err(new AgentRunError(previous.recoveredState.error!, { cause: stopped.error }));
        } else if (this.shuttingDown || previous.phase !== "open") {
          result = err(new CancelledError("Session replacement was cancelled by shutdown."));
        } else {
          const replacement: OpenExecution = {
            id: previous.id,
            name: previous.name,
            role: "main",
            scope: previous.scope,
            ...(previous.worktree ? { worktree: previous.worktree } : {}),
            phase: "open",
            children: new Map(),
            ready,
            executor: next,
            generation,
            managed: true,
            ...(key.value ? { fileKey: key.value } : {}),
          };
          replacement.observedResultId = next.state.result?.id;
          replacement.unsubscribe = next.subscribe(() => this.executionChanged(replacement));
          previous.unsubscribe?.();
          delete previous.unsubscribe;
          if (previous.fileKey && this.fileOwners.get(previous.fileKey) === previous.id) {
            this.fileOwners.delete(previous.fileKey);
          }
          if (key.value) {
            this.fileOwners.set(key.value, replacement.id);
          }

          this.retire(previous, archived);
          this.entries.set(previous.id, replacement);
          adopted = true;
          this.emit();

          return ok(undefined);
        }
      }
    } catch (error) {
      if (adopted) {
        throw error;
      }
      if (stopping) {
        previous.recoveredState = {
          ...previous.executor!.state,
          status: "failure",
          error: "Unexpected session replacement failure. Inspect runtime.log before retrying.",
        };
      }
      try {
        const cleanup = await next.close();
        if (!cleanup.ok) {
          throw cleanup.error;
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Replacement and cleanup failed.");
      }

      throw error;
    }

    const cleanup = await next.close();

    return cleanup.ok
      ? result
      : err(
          new CleanupError("Replacement and cleanup failed.", [
            ...(!result.ok ? [result.error] : []),
            cleanup.error,
          ]),
        );
  }

  close(id: string): Promise<Result<void, ExpectedError>> {
    const entry = this.entries.get(id);
    if (!entry) {
      return Promise.resolve(ok(undefined));
    }
    if (entry.closeTask) {
      return entry.closeTask;
    }
    if (entry.phase !== "closing") {
      entry.closedAt = Date.now();
    }

    const archived = this.retire(entry);
    entry.phase = "closing";
    if (entry.childrenTimer) clearTimeout(entry.childrenTimer);

    const task = Promise.resolve().then(async () => {
      const result = await collectCleanup(
        [
          this.closeExecution(entry),
          ...[...entry.children.values()].map((child) => this.closeExecution(child)),
        ],
        `Could not finish closing ${entry.name}`,
      );
      if (!result.ok) {
        delete entry.closeTask;
        this.emit();

        return result;
      }

      this.retire(entry, archived);
      this.entries.delete(id);
      if (entry.fileKey && this.fileOwners.get(entry.fileKey) === id) {
        this.fileOwners.delete(entry.fileKey);
      }

      this.emit();

      return ok(undefined);
    });
    entry.closeTask = task;
    // Reset retries for unexpected exceptions too, without consuming the caller's rejected task.
    void task.catch(() => {
      delete entry.closeTask;
    });
    this.emit();

    return task;
  }

  async shutdown(): Promise<Result<void, ExpectedError>> {
    this.shuttingDown = true;

    return collectCleanup(
      [...this.entries.keys()]
        .map((id) => this.close(id))
        .concat([...this.replacements].map((task) => task.then(() => ok(undefined)))),
      "Some session executions could not be shut down.",
    );
  }

  private notifyChild(owner: OpenExecution, child: Execution, event: SubagentNoticePayload): void {
    if (
      this.entries.get(owner.id) !== owner ||
      owner.phase !== "open" ||
      owner.replacing ||
      child.suppressNotifications ||
      !child.backgroundAccepted ||
      this.shuttingDown
    )
      return;
    const version = (child.noticeVersion ?? 0) + 1;
    child.noticeVersion = version;
    owner.executor?.notifySubagent?.({ ...event, id: child.id, agent: child.name }, () => {
      if (
        this.entries.get(owner.id) !== owner ||
        owner.phase !== "open" ||
        owner.replacing ||
        child.suppressNotifications ||
        this.shuttingDown ||
        version <= (child.observedNoticeVersion ?? 0)
      )
        return false;
      if (event.type === "finished") return !child.terminalObserved;
      if (child.settled || !child.ready || child.controller?.signal.aborted) return false;
      if (event.type === "question")
        return (
          child.channel?.questions.some((question) => question.id === event.question.id) === true
        );
      return !child.channel?.questions.length;
    });
  }

  private async coordinateSubagents(
    ownerId: string,
    generation: string,
    command: SubagentCommand,
    signal?: AbortSignal,
    purpose?: "planning",
  ): Promise<Result<unknown, ExpectedError>> {
    const selected = this.requireOpen(ownerId);
    if (!selected.ok) return selected;
    const owner = selected.value;
    if (owner.generation !== generation)
      return err(
        new SessionError("SESSION_CONFLICT", "This conversation no longer owns those runs."),
      );
    if (owner.replacing)
      return err(new SessionError("SESSION_BUSY", "This conversation is being replaced."));
    if (signal?.aborted) return err(new CancelledError());
    if (command.action === "list")
      return err(new CapabilityError("Profile discovery belongs to the session resource loader."));
    if (command.action === "spawn") {
      if (command.async === false && [...owner.children.values()].some((child) => child.ready))
        return err(
          new CapabilityError(
            "Use asynchronous spawn while other owned runs are active so questions can be answered.",
          ),
        );
      if ([...owner.children.values()].filter((child) => child.ready).length >= 5)
        return err(new InputError("This parent already has five active subagents."));
      if (owner.children.size >= 128)
        return err(
          new InputError(
            "This conversation has reached its retained-run limit. Start a new conversation.",
          ),
        );
      const background = command.async !== false;
      let childId: string | undefined;
      const result = await this.spawnSubagent(
        ownerId,
        command.agent,
        command.task,
        signal,
        generation,
        background,
        (id) => {
          childId = id;
        },
        purpose,
      );
      return result.ok
        ? ok(this.childStatus(owner.children.get(childId!)!, true, purpose))
        : result;
    }
    const children = command.id ? [owner.children.get(command.id)] : [...owner.children.values()];
    if (children.some((child) => !child))
      return err(new InputError("This run does not belong to the current conversation."));
    const runs = children as Execution[];
    if (purpose && runs.some((child) => child.purpose !== purpose))
      return err(new InputError("This run does not belong to the planning request."));
    if (command.action === "status")
      return ok(runs.map((child) => this.childStatus(child, command.id !== undefined, purpose)));
    if (command.action === "wait") {
      const settled = () =>
        runs.every((child) => !child.ready || child.settled) ||
        (purpose ? runs : [...owner.children.values()]).some(
          (child) => child.channel?.questions.length,
        );
      if (!settled()) {
        const response = Promise.withResolvers<void>();
        const cancel = () => response.resolve();
        const unsubscribe = this.subscribe(() => {
          if (settled() || owner.phase !== "open" || owner.replacing) response.resolve();
        });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          await response.promise;
        } finally {
          unsubscribe();
          signal?.removeEventListener("abort", cancel);
        }
        if (signal?.aborted || owner.phase !== "open" || owner.replacing)
          return err(new CancelledError());
      }
      if (runs.every((child) => !child.ready || child.settled))
        await Promise.all(runs.flatMap((child) => (child.completion ? [child.completion] : [])));
      if (
        signal?.aborted ||
        this.entries.get(ownerId) !== owner ||
        owner.phase !== "open" ||
        owner.replacing
      )
        return err(new CancelledError());
      const attention = purpose
        ? []
        : [...owner.children.values()].filter(
            (child) => child.channel?.questions.length && !runs.includes(child),
          );
      return ok(
        [...runs, ...attention].map((child) =>
          this.childStatus(child, command.id !== undefined, purpose),
        ),
      );
    }
    const child = runs[0]!;
    if (command.action === "reply")
      return (
        child.channel?.reply(command.questionId, command.message) ??
        err(new InputError("This run has no pending questions."))
      );
    if (command.action === "stop") {
      child.suppressNotifications = true;
      const stopped = await this.closeExecution(child);
      return stopped.ok ? ok(this.childStatus(child, true, purpose)) : stopped;
    }
    if (!child.ready || !child.executor?.steer)
      return err(new InputError("This run is no longer accepting guidance."));
    if (child.channel?.questions.length)
      return err(
        new InputError("Answer the pending question with reply; steer does not answer questions."),
      );
    return child.executor.steer(command.message);
  }

  private childStatus(child: Execution, detail = true, purpose?: "planning"): unknown {
    const state = child.executor?.state;
    child.observedNoticeVersion = child.noticeVersion ?? 0;
    if (!child.ready || child.settled) child.terminalObserved = true;
    return {
      id: child.id,
      agent: child.name,
      task: (child.task ?? child.request?.text)?.slice(0, detail ? 16_384 : 400),
      status: child.failure
        ? "failure"
        : child.channel?.questions.length
          ? "waiting"
          : child.ready
            ? "working"
            : (child.finishedStatus ?? "stopped"),
      currentTools: state?.activeTools ?? [],
      progress: (child.channel?.progress ?? child.progress ?? [])
        .slice(detail ? -16 : -1)
        .map((update) => ({ ...update, message: update.message.slice(0, detail ? 2048 : 512) })),
      questions: (child.channel?.questions ?? []).map((question) => ({
        ...question,
        message: question.message.slice(0, detail ? 16_384 : 512),
      })),
      output: (state?.finalOutput ?? child.finalOutput ?? "").slice(0, 16_384),
      recentOutput: (state?.output ?? child.output ?? "").slice(detail ? -16_384 : -512),
      ...(child.failure ? { error: child.failure } : {}),
      ...((state?.runTiming ?? child.runTiming)
        ? { runTiming: state?.runTiming ?? child.runTiming }
        : {}),
      ...(child.fileKey ? { sessionFile: child.fileKey } : {}),
      ...(purpose === "planning" &&
      child.purpose === "planning" &&
      child.settled &&
      !child.failure &&
      child.planningProposal
        ? { proposal: structuredClone(child.planningProposal) }
        : {}),
    };
  }

  private async spawnSubagent(
    ownerId: string,
    name: string,
    task: string,
    signal?: AbortSignal,
    generation?: string,
    background = false,
    onCreated?: (id: string) => void,
    purpose?: "planning",
  ): Promise<Result<string, ExpectedError>> {
    const selected = this.requireOpen(ownerId);
    if (!selected.ok) {
      return selected;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }

    const owner = selected.value;
    if (generation && generation !== owner.generation) {
      return err(
        new SessionError(
          "SESSION_CONFLICT",
          "The originating conversation is no longer active in this tab.",
        ),
      );
    }
    if (owner.replacing) {
      return err(new SessionError("SESSION_BUSY", "This conversation is being replaced."));
    }

    const child: Execution = {
      id: crypto.randomUUID(),
      name,
      task,
      role: "subagent",
      ...(purpose ? { purpose } : {}),
      ready: undefined,
      controller: new AbortController(),
      ...(owner.worktree ? { worktree: owner.worktree } : {}),
      managed: true,
      request: summarizeRequest(task, 0),
    };
    child.channel = new SubagentChannel((event) => {
      if (event.type !== "question-settled") this.notifyChild(owner, child, event);
      this.emit();
    });
    const ready = capture(() =>
      this.factory({
        cwd: owner.worktree?.path ?? homedir(),
        scope: owner.scope,
        ...(owner.scope.kind === "code" ? { worktreeId: owner.scope.worktreeId } : {}),
        role: "subagent",
        agent: name,
        ...(purpose ? { purpose } : {}),
        contactSupervisor: (command, childSignal) => {
          if (
            owner.phase !== "open" ||
            owner.replacing ||
            child.controller!.signal.aborted ||
            childSignal?.aborted
          )
            return Promise.resolve(err(new CancelledError()));
          if (command.action === "proposal") {
            if (purpose !== "planning")
              return Promise.resolve(
                err(new CapabilityError("Only a planning run may return a plan proposal.")),
              );
            const proposal = validatePlanningProposal(command.proposal);
            if (!proposal.ok) return Promise.resolve(proposal);
            child.planningProposal = structuredClone(proposal.value);
            return Promise.resolve(ok({ recorded: true }));
          }
          if (!background && command.action === "ask")
            return Promise.resolve(
              err(
                new CapabilityError(
                  "A synchronous parent cannot answer questions. Use asynchronous spawn.",
                ),
              ),
            );
          return child.channel!.contact(command, childSignal);
        },
        spawnSubagent: async () => err(new InputError("Nested delegation is not enabled.")),
      }),
    );
    child.ready = ready;
    if (owner.childrenSettledAt !== undefined && Date.now() >= owner.childrenSettledAt + 10_000) {
      owner.hiddenChildren ??= new Set();
      for (const id of owner.children.keys()) owner.hiddenChildren.add(id);
    }
    owner.children.set(child.id, child);
    onCreated?.(child.id);
    this.emit();

    let cancelTask: Promise<Result<void, ExpectedError>> | undefined;
    const cancel = () => {
      cancelTask = this.closeExecution(child);
      // The event callback cannot await. Observe now; the same task is awaited below, not discarded.
      void cancelTask.catch(() => {});
    };

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();

    const complete = this.completeChild(
      owner,
      child,
      ready,
      task,
      child.controller!.signal,
      () => cancelTask,
    ).finally(() => {
      child.settled = true;
      this.emit();
    });
    child.completion = complete;
    if (background) {
      void complete
        .then((result) => {
          this.notifyChild(owner, child, {
            type: "finished",
            status:
              child.failure || child.finishedStatus === "failure"
                ? "failure"
                : child.finishedStatus === "complete"
                  ? "complete"
                  : "stopped",
            ...(child.finalOutput !== undefined
              ? { output: child.finalOutput.slice(0, 4000) }
              : {}),
            ...(!result.ok ? { error: result.error.message } : {}),
          });
        })
        .catch((error: unknown) => {
          child.failure = reportUnexpected(error, "background subagent execution");
          this.emit();
          this.notifyChild(owner, child, {
            type: "finished",
            status: "failure",
            error: child.failure,
          });
        });
      const created = await ready;
      signal?.removeEventListener("abort", cancel);
      if (!created.ok) {
        await complete;
        return created;
      }
      if (
        signal?.aborted ||
        this.entries.get(ownerId) !== owner ||
        owner.phase !== "open" ||
        owner.replacing
      ) {
        await this.closeExecution(child);
        return err(new CancelledError());
      }
      child.backgroundAccepted = true;
      return ok(child.id);
    }
    try {
      return await complete;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  private async completeChild(
    owner: OpenExecution,
    child: Execution,
    ready: NonNullable<Execution["ready"]>,
    task: string,
    signal: AbortSignal,
    cancellation: () => Promise<Result<void, ExpectedError>> | undefined,
  ): Promise<Result<string, ExpectedError>> {
    let result: Result<string, ExpectedError>;
    try {
      result = await this.runChild(owner, child, ready, task, signal);
    } catch (error) {
      try {
        const cleanup = await this.closeExecution(child);
        if (!cleanup.ok) {
          throw cleanup.error;
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Subagent execution and cleanup failed.");
      }

      throw error;
    }
    if (result.ok) child.finalOutput = result.value;
    if (!result.ok && !(result.error instanceof CancelledError) && owner.phase === "open") {
      child.failure = result.error.message;
      this.emit();
    }

    const cleanup = await (cancellation() ?? this.closeExecution(child));
    if (!cleanup.ok) {
      child.failure = cleanup.error.message;
      if (owner.phase === "open") {
        this.emit();
      }

      return result.ok
        ? cleanup
        : err(
            new CleanupError("Subagent execution and cleanup failed.", [
              result.error,
              cleanup.error,
            ]),
          );
    }

    return result;
  }

  private async runChild(
    owner: OpenExecution,
    child: Execution,
    ready: NonNullable<Execution["ready"]>,
    task: string,
    signal?: AbortSignal,
  ): Promise<Result<string, ExpectedError>> {
    const created = await ready;
    if (!created.ok) {
      return created;
    }

    const executor = created.value;
    child.executor = executor;

    const key = await capture(() => this.fileKey(executor));
    if (!key.ok) {
      return key;
    }

    const selected = this.requireOpen(owner.id);
    if (!selected.ok) {
      return selected;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (key.value) {
      if (this.fileOwners.has(key.value)) {
        return err(
          new SessionError("SESSION_CONFLICT", "The subagent saved session already has a writer."),
        );
      }

      child.fileKey = key.value;
      this.fileOwners.set(key.value, child.id);
    }

    child.unsubscribe = executor.subscribe(() => {
      if (owner.phase === "open") {
        this.emit();
      }
    });
    this.emit();

    const startedAt = Date.now();
    const started = performance.now();

    child.runTiming = { startedAt, elapsedMs: 0 };

    let run: Result<void, ExpectedError>;
    try {
      run = await executor.prompt(task);
    } finally {
      child.runTiming = { startedAt, elapsedMs: Math.max(0, performance.now() - started) };
    }
    if (!run.ok) {
      return run;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (executor.state.status === "failure") {
      return err(new AgentRunError(executor.state.error ?? "Subagent failed."));
    }

    return ok(executor.state.finalOutput ?? "");
  }

  private closeExecution(
    execution: Execution,
    reason: "quit" | "new" = "quit",
  ): Promise<Result<void, ExpectedError>> {
    if (execution.cleanupTask) {
      return execution.cleanupTask;
    }

    execution.channel?.close();
    execution.controller?.abort();
    const ready = execution.ready;
    if (!ready) {
      return Promise.resolve(ok(undefined));
    }

    const task = (async (): Promise<Result<void, ExpectedError>> => {
      const created = await ready;
      if (!created.ok) {
        execution.ready = undefined;
        execution.closedAt ??= Date.now();
        this.emit();
        return ok(undefined);
      } // Factory failure is returned to create/runChild; no handle exists.

      const scope =
        execution.role === "subagent"
          ? this.entries.values().find((entry) => entry.children.has(execution.id))?.scope
          : undefined;
      const tree = execution.worktree;
      if (scope) {
        execution.closedAt ??= Date.now();
      }

      const archived = scope
        ? this.retireExecution(execution, scope, tree, [], created.value)
        : undefined;
      const closed = await created.value.close(reason);
      if (!closed.ok) {
        delete execution.cleanupTask;

        return closed;
      }

      execution.unsubscribe?.();
      delete execution.unsubscribe;
      if (execution.role === "subagent") {
        if (scope) {
          this.retireExecution(execution, scope, tree, [], created.value, archived);
        }
        if (execution.fileKey && this.fileOwners.get(execution.fileKey) === execution.id) {
          this.fileOwners.delete(execution.fileKey);
        }

        execution.output ??= created.value.state.output;
        const finalOutput = created.value.state.finalOutput;
        if (finalOutput !== undefined) execution.finalOutput ??= finalOutput;
        execution.finishedStatus =
          created.value.state.status === "working" ? null : created.value.state.status;
        execution.ready = undefined;
        delete execution.executor;
        this.emit();
      }

      return ok(undefined);
    })();
    execution.cleanupTask = task;
    void task.catch(() => {
      delete execution.cleanupTask;
    });

    return task;
  }

  private async fileKey(executor: SessionExecutor): Promise<string | undefined> {
    const file = executor.sessionFile;

    return file ? join(await realpath(dirname(file)), basename(file)) : undefined;
  }

  private requireOpen(id: string): Result<OpenExecution, SessionError> {
    if (this.shuttingDown) {
      return err(this.stopping());
    }

    const entry = this.entries.get(id);

    return !entry || entry.phase !== "open" || !entry.executor
      ? err(new SessionError("SESSION_NOT_OPEN", "Session is not open."))
      : ok(entry);
  }

  private stopping(): SessionError {
    return new SessionError("RUNTIME_STOPPING", "Session registry is shutting down.");
  }

  private emit(): void {
    for (const entry of this.entries.values()) {
      const children = [...entry.children.values()];
      const running = children.some((child) => child.ready !== undefined);
      if (running || !children.length) {
        delete entry.childrenSettledAt;
        if (entry.childrenTimer) clearTimeout(entry.childrenTimer);
        delete entry.childrenTimer;
      } else if (entry.phase === "open" && !entry.replacing) {
        entry.childrenSettledAt ??= Math.max(
          ...children.map((child) => child.closedAt ?? Date.now()),
        );
        const remaining = entry.childrenSettledAt + 10_000 - Date.now();
        if (remaining > 0 && !entry.childrenTimer) {
          entry.childrenTimer = setTimeout(() => {
            delete entry.childrenTimer;
            this.emit();
          }, remaining);
          entry.childrenTimer.unref();
        }
      }
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export async function validateHistory(file: string): Promise<Result<void, ExpectedError>> {
  const read = await capture(() => Bun.file(file).text());
  if (!read.ok) {
    return read;
  }

  const lines = read.value.split("\n").filter((line) => line.trim());
  if (!lines.length) {
    return err(
      new HistoryError(
        "HISTORY_CORRUPT",
        "Saved conversation file has no valid session header; refusing to overwrite it.",
      ),
    );
  }
  for (const [index, line] of lines.entries()) {
    const parsed = parseJson(line, "saved conversation");
    if (!parsed.ok) {
      return err(
        new HistoryError("HISTORY_CORRUPT", parsed.error.message, { cause: parsed.error }),
      );
    }

    const value = parsed.value;
    if (
      index === 0 &&
      (!value || typeof value !== "object" || !("type" in value) || value.type !== "session")
    ) {
      return err(
        new HistoryError(
          "HISTORY_CORRUPT",
          "Saved conversation file has no valid session header; refusing to overwrite it.",
        ),
      );
    }
  }

  return ok(undefined);
}
