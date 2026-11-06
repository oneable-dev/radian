import { realpath } from "node:fs/promises";
import {
  parseWorkflowCommand,
  workflowCommand,
  workflowSummary,
  type WorkflowCommand,
} from "./workflow-command.ts";
import { previewExecution, validateExecutionConsent, renderConsent } from "./workflow-consent.ts";
import { executionProfileSnapshot, scheduleExecution } from "./workflow-execution-scheduler.ts";
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
  DelegationError,
  WorkflowError,
  reportUnexpected,
  type ExpectedError,
} from "../errors.ts";
import type { AgentProfile } from "./agent-profiles.ts";
import type { ToolEnforcement } from "./leaf-extension.ts";
import { profileAdmission, type EffectiveProfileSnapshot } from "./effective-profile.ts";
import { err, ok, type Result } from "../result.ts";
import type { TranscriptSection } from "./transcript.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import {
  filterCatalog,
  filterCompletions,
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
import type { SubagentCommand, SupervisorCommand, TaskSpawnBinding } from "./subagent-tools.ts";
import type { TaskCommand } from "./task-tool.ts";
import type { SubagentNotice, SubagentNoticePayload } from "./subagent-notifications.ts";
import { validatePlanningProposal, type PlanningProposal } from "./planning-proposal.ts";
import {
  repairCommand,
  parseRepairCommand,
  resolveRepairId,
  renderRepairStatus,
  type RepairCommand,
  type UserCommandProvenance,
} from "./repair-command.ts";
import {
  openWorkflow,
  mutateWorkflow,
  writeWorkflowLink,
  type OpenedWorkflow,
} from "./task-workflow-store.ts";
import {
  createWorkflowDocument,
  renderWorkflowStatus,
  renderHumanHandoff,
  type WorkflowBinding,
  type WorkflowDocument,
  type WorkflowPolicyResult,
} from "./task-workflow.ts";
import {
  humanStatus,
  humanRecheck,
  humanCancel,
  addContinuationMember,
  recoverWorkflow,
  admitRepair,
  recordFinding,
  recordVerdict,
  submitImplementation,
  recordAnalysis,
  publishPlanArtifact,
  declareScope,
  declareSubtasks,
  reassign,
  continueTask,
  splitTask,
  isTaskLead,
} from "./verification-policy.ts";
import {
  TaskRouting,
  resolveTaskBinding,
  authorizeTaskBinding,
  guardImplementation,
  guardUnboundTask,
  type TaskRecipient,
} from "./task-routing.ts";

import {
  PlanningSchedulerDriver,
  type PlanningSchedulerControl,
} from "./workflow-scheduler-driver.ts";
import {
  activeAdmission,
  capturePlanInputs,
  schedule,
  type FrozenPlanInputs,
  type SchedulerAdmission,
  type SchedulerIntent,
} from "./workflow-scheduler.ts";

export type ExecutionState = {
  readonly conversationId?: string;
  readonly resourceRevision?: number;
  readonly status: AgentStatus | null;
  readonly activity?: "compacting";
  readonly workflow?: string;
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
  readonly runTiming?: {
    readonly startedAt: number;
    readonly elapsedMs: number;
  };
};

export type SessionExecutor = {
  readonly workflowScheduler?: { profiles(): Result<AgentProfile[], ExpectedError> } | undefined;
  readonly enforcement?: ToolEnforcement | undefined;
  readonly effectiveProfile?: EffectiveProfileSnapshot | undefined;
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
  notifySubagent?(
    event: SubagentNotice,
    current?: () => boolean,
    delivered?: (accepted?: boolean) => void,
  ): void;
  appendNotice?(text: string): Promise<Result<void, ExpectedError>>;
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
  /** Host-resolved launch profile, frozen at spawn so later edits cannot change this run. */
  readonly profile?: AgentProfile;
  readonly purpose?: "planning" | "analysis";
  readonly binding?: WorkflowBinding;
  controlPlanningScheduler?(
    command: PlanningSchedulerControl,
  ): Promise<Result<void, ExpectedError>>;
  planningSchedulerOwnership?():
    | { invocationId: string; state: "active" | "cancelling" | "cleanup-uncertain" }
    | undefined;
  /** Revalidate durable write authority for each mutating SDK tool call. */
  authorizeTool?(toolName: string): Promise<Result<void, ExpectedError>>;
  coordinateTask?(
    command: TaskCommand,
    toolCallId: string,
    signal?: AbortSignal,
    knownProfiles?: string[],
  ): Promise<Result<unknown, ExpectedError>>;
  /** Present for roots and for host-authorized delegating children only. */
  coordinateSubagents?(
    command: SubagentCommand,
    signal?: AbortSignal,
    purpose?: "planning" | "analysis",
    target?: AgentProfile,
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
  readonly effectiveProfile?: EffectiveProfileSnapshot;
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

/**
 * Minimal metadata of a conversation owned by a removed worktree scope. It identifies files
 * for deletion cleanup only and is never restorable checkpoint content.
 */
export type SessionDeletionCandidate = {
  readonly worktreeId: string;
  readonly sessionId: string;
  readonly role: "main" | "subagent";
  readonly conversationId: string;
  readonly sessionFile?: string;
  readonly managed: boolean;
};

// Creation is an exception-based SDK boundary. The registry converts only classified failures.
export type SessionFactory = (context: SessionContext) => Promise<SessionExecutor>;

// Run-tree limits. The root is depth 0 and is not counted against its own capacity.
export const delegationLimits = {
  maxDepth: 3,
  activeDescendants: 5,
  retainedRuns: 128,
} as const;

type RepairTarget = { readonly defectId: string; readonly attemptId: string };

function renderFrozenPlanInputs(
  doc: WorkflowDocument,
  taskId: string,
  inputs: FrozenPlanInputs,
): string {
  const lines = [`Frozen inputs for ${taskId} (captured at spawn; respawn to refresh):`];
  // Reserve space for the retrieval hint even when a large declaration exceeds the budget.
  for (const { artifactId, revision } of inputs.dependencies) {
    const artifact = doc.artifacts[artifactId];
    const item = artifact?.revisions.find((item) => item.revision === revision);
    lines.push(
      `  ${artifactId}@${revision} (${artifact?.taskId}): ${(item?.summary ?? "Summary unavailable").replace(/[\r\n]/g, " ").slice(0, 512)}`,
    );
  }
  for (const id of inputs.missing) lines.push(`  ${id}: missing (no current artifact at spawn)`);
  const text = lines.join("\n");
  return `${text.length > 7800 ? `${text.slice(0, 7750)}\n[Inputs truncated]` : text}\nRetrieve: radian-task status artifact=<ref@revision>`;
}

type Execution = {
  readonly operationId?: string;
  readonly enforcement?: ToolEnforcement;
  readonly effectiveProfile?: EffectiveProfileSnapshot;
  readonly id: string;
  readonly name: string;
  readonly role: "main" | "subagent";
  readonly purpose?: "planning" | "analysis";
  readonly binding?: WorkflowBinding;
  readonly repairTarget?: RepairTarget;
  readonly planInputs?: FrozenPlanInputs;
  repairClaim?: string;
  writeClosed?: boolean;
  submittedRevision?: number;
  readonly profile?: AgentProfile;
  // Subagent ancestry. Absent on roots; restored legacy records attach to the root.
  owner?: Execution;
  root?: OpenExecution;
  depth?: number;
  delegating?: boolean;
  children?: Map<string, Execution>;
  subtreeTask?: Promise<Result<void, ExpectedError>>;
  // Keep a supervisor active until its whole subtree, not just its own handle, is closed.
  closing?: boolean;
  // Final text produced while owned runs were still active is not a genuine result.
  unfinished?: boolean;
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
  executionOwnership?: {
    invocationId: string;
    consentId: string;
    driver: PlanningSchedulerDriver;
    cancelling?: boolean;
    profiles(): Result<AgentProfile[], ExpectedError>;
  };

  schedulerOwnership?: {
    invocationId: string;
    state: "active" | "cancelling" | "cleanup-uncertain";
    driver: PlanningSchedulerDriver;
    initialize(): Promise<Result<void, ExpectedError>>;
  };
  schedulerControl?: Promise<unknown>;
  workflowSummary?: string;
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

function entrySummary(root: OpenExecution, doc: WorkflowDocument): void {
  const summary = workflowSummary(doc);
  if (summary) root.workflowSummary = summary;
  else delete root.workflowSummary;
}

export class SessionRegistry {
  private readonly entries = new Map<string, OpenExecution>();
  private readonly listeners = new Set<() => void>();
  private readonly fileOwners = new Map<string, string>();
  private readonly retired = new Map<string, SessionRecord>();
  private readonly taskRouting = new TaskRouting();
  private readonly startingRuns = new Map<symbol, OpenExecution>();
  // Single-host claims include pending creation and closing runs, not just model turns.
  private readonly repairClaims = new Map<string, Execution>();
  private shuttingDown = false;
  private uiActive = false;
  private readonly replacements = new Set<Promise<Result<void, ExpectedError>>>();
  // Deleted worktree scopes reject new work. Epochs advance on each fence so work started
  // for an old scope cannot complete into a scope released for a recreated directory.
  private readonly fencedWorktrees = new Set<string>();
  private readonly worktreeEpochs = new Map<string, number>();
  private readonly scopedOperations = new Map<Promise<unknown>, string>();
  private readonly deletionCandidates = new Map<string, Map<string, SessionDeletionCandidate>>();
  // Executors of removed scopes whose close failed after they lost their registry entry.
  private readonly strandedExecutors = new Map<SessionExecutor, string>();

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
        ? [
            {
              sessionId: entry.id,
              conversationId: entry.executor!.savedSessionId,
              ...state,
            },
          ]
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
    return new Set([
      ...[...this.entries.values()].flatMap((entry) =>
        entry.scope.kind === "code" ? [entry.scope.worktreeId] : [],
      ),
      ...this.scopedOperations.values(),
      ...this.strandedExecutors.values(),
    ]);
  }

  /**
   * Synchronously blocks new and pending work for deleted worktree scopes. Idempotent.
   * CHAT and unrelated worktrees are unaffected.
   */
  fenceWorktrees(worktreeIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of worktreeIds) {
      if (this.fencedWorktrees.has(id)) {
        continue;
      }

      this.fencedWorktrees.add(id);
      this.worktreeEpochs.set(id, (this.worktreeEpochs.get(id) ?? 0) + 1);
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  /**
   * Fences and terminates every execution of the given worktree scopes, including owned
   * children and pending creation or replacement. Their records are no longer checkpointed;
   * every conversation they owned, including ones created after the fence, is returned as a
   * deletion candidate once all scoped work has drained. Idempotent; on failure the remaining
   * executions stay retained for retry and `worktreeDeletionCandidates` reports partial
   * inventory.
   */
  async destroyWorktrees(
    worktreeIds: ReadonlySet<string>,
  ): Promise<Result<readonly SessionDeletionCandidate[], ExpectedError>> {
    this.fenceWorktrees(worktreeIds);
    this.moveRetiredToCandidates(worktreeIds);

    // Pending operations may start closes or replacements of their own; drain until stable.
    while (true) {
      const pending = [...this.scopedOperations]
        .filter(([, id]) => worktreeIds.has(id))
        // Each operation reports its own outcome to its caller; deletion only waits for it.
        .map(([task]) => task.then(settledOk, settledOk));
      const closing = [...this.entries.values()]
        .filter((entry) => entry.scope.kind === "code" && worktreeIds.has(entry.scope.worktreeId))
        .map((entry) => this.close(entry.id));
      const stranded = [...this.strandedExecutors]
        .filter(([, id]) => worktreeIds.has(id))
        .map(([executor]) => this.closeStranded(executor));
      if (!pending.length && !closing.length && !stranded.length) {
        break;
      }

      const result = await collectCleanup(
        [...closing, ...stranded, ...pending],
        "Could not stop every session of the removed worktrees.",
      );
      this.moveRetiredToCandidates(worktreeIds);
      if (!result.ok) {
        return result;
      }
    }

    return ok(this.worktreeDeletionCandidates(worktreeIds));
  }

  /** Conversations of removed scopes observed so far, for cleanup inventory only. */
  worktreeDeletionCandidates(worktreeIds: ReadonlySet<string>): SessionDeletionCandidate[] {
    return [...worktreeIds].flatMap((id) => [...(this.deletionCandidates.get(id)?.values() ?? [])]);
  }

  /**
   * Opens a new scope generation for worktree IDs whose previous generation was destroyed,
   * for example a directory recreated at the same path. Call only after the deletion
   * candidates were purged; they are forgotten here. Refuses while old work remains.
   */
  releaseWorktrees(worktreeIds: ReadonlySet<string>): Result<void, ExpectedError> {
    const retained = this.retainedWorktreeIds;
    if ([...worktreeIds].some((id) => retained.has(id))) {
      return err(
        new SessionError(
          "SESSION_BUSY",
          "Sessions of the removed worktree are still stopping; the scope was not released.",
        ),
      );
    }

    this.moveRetiredToCandidates(worktreeIds);
    for (const id of worktreeIds) {
      this.fencedWorktrees.delete(id);
      this.deletionCandidates.delete(id);
    }

    this.emit();

    return ok(undefined);
  }

  private moveRetiredToCandidates(worktreeIds: ReadonlySet<string>): void {
    for (const [key, record] of this.retired) {
      if (
        record.scope?.kind !== "chat" &&
        record.worktreeId &&
        worktreeIds.has(record.worktreeId)
      ) {
        this.retired.delete(key);
        this.noteRecordCandidate(record);
      }
    }
  }

  private noteRecordCandidate(record: SessionRecord): void {
    if (record.scope?.kind === "chat" || !record.worktreeId) {
      return;
    }

    this.noteCandidate({
      worktreeId: record.worktreeId,
      sessionId: record.id,
      role: record.role ?? "main",
      conversationId: record.state.conversationId ?? record.id,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      managed: record.managed ?? false,
    });
    for (const child of record.ownedSubagents ?? []) {
      if (child.sessionFile) {
        this.noteCandidate({
          worktreeId: record.worktreeId,
          sessionId: child.id,
          role: "subagent",
          conversationId: child.id,
          sessionFile: child.sessionFile,
          managed: true,
        });
      }
    }
  }

  private noteExecutorCandidate(
    scope: SessionScope,
    sessionId: string,
    role: "main" | "subagent",
    executor: SessionExecutor,
    managed: boolean,
  ): void {
    if (scope.kind !== "code") {
      return;
    }

    const sessionFile = executor.sessionFile;
    this.noteCandidate({
      worktreeId: scope.worktreeId,
      sessionId,
      role,
      conversationId: executor.savedSessionId,
      ...(sessionFile ? { sessionFile } : {}),
      managed,
    });
  }

  private noteCandidate(candidate: SessionDeletionCandidate): void {
    let candidates = this.deletionCandidates.get(candidate.worktreeId);
    if (!candidates) {
      candidates = new Map();
      this.deletionCandidates.set(candidate.worktreeId, candidates);
    }

    // Child records from owner snapshots may precede the child's own executor observation.
    const key = candidate.sessionFile ?? `${candidate.role}:${candidate.conversationId}`;
    const previous = candidates.get(key);
    candidates.set(
      key,
      previous && candidate.role === "subagent" && candidate.conversationId === candidate.sessionId
        ? previous
        : candidate,
    );
  }

  private closeStranded(executor: SessionExecutor): Promise<Result<void, ExpectedError>> {
    return executor.close().then((closed) => {
      if (closed.ok) {
        this.strandedExecutors.delete(executor);
      }

      return closed;
    });
  }

  // A replacement handle that failed to close outside a removed scope keeps the existing
  // error-reporting contract; inside one it stays retained so deletion can retry it.
  private strandIfRemoved(scope: SessionScope, executor: SessionExecutor): void {
    if (scope.kind === "code" && this.scopeFenced(scope)) {
      this.strandedExecutors.set(executor, scope.worktreeId);
    }
  }

  private scopeFenced(scope: SessionScope): boolean {
    return scope.kind === "code" && this.fencedWorktrees.has(scope.worktreeId);
  }

  private scopeEpoch(scope: SessionScope): number {
    return scope.kind === "code" ? (this.worktreeEpochs.get(scope.worktreeId) ?? 0) : 0;
  }

  private scopeCurrent(scope: SessionScope, epoch: number): boolean {
    return !this.scopeFenced(scope) && this.scopeEpoch(scope) === epoch;
  }

  private trackScoped<T>(scope: SessionScope, task: Promise<T>): Promise<T> {
    if (scope.kind === "code") {
      this.scopedOperations.set(task, scope.worktreeId);
      const untrack = () => {
        this.scopedOperations.delete(task);
      };
      void task.then(untrack, untrack);
    }

    return task;
  }

  private scopeRemoved(): SessionError {
    return new SessionError(
      "SESSION_NOT_OPEN",
      "This worktree was removed; no session work was accepted.",
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
                  : this.visibleChildren(entry),
              ...(state?.workflow ? { workflow: state.workflow } : {}),
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
          ...(state?.workflow ? { workflow: state.workflow } : {}),
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
    const detailed = entry.workflowSummary ? { ...state, workflow: entry.workflowSummary } : state;
    return entry.attention ? { ...detailed, attention: entry.attention } : detailed;
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
      return {
        openSessionId: null,
        unavailableReason: "Saved session cleanup is in progress.",
      };
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
          ...(this.details(entry.id) ?? {
            status: null,
            output: "",
            error: null,
          }),
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

  // Retain closed records only until the shared store confirms persistence. Removed
  // worktree scopes are never checkpointed again, so late saves cannot resurrect them.
  get checkpointRecords(): readonly SessionRecord[] {
    return [...this.retired.values(), ...this.records].filter(
      (record) =>
        record.scope?.kind === "chat" ||
        !record.worktreeId ||
        !this.fencedWorktrees.has(record.worktreeId),
    );
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
    if (this.scopeFenced(entry.scope)) {
      this.noteRecordCandidate(record);
    } else {
      this.retired.set(sessionRecordKey(record), record);
    }
    return record;
  }

  private ownedRecords(entry: OpenExecution): OwnedSubagentRecord[] {
    const expired =
      entry.childrenSettledAt !== undefined && Date.now() >= entry.childrenSettledAt + 10_000;
    return [...this.descendants(entry)].map((child) => {
      const state = child.executor?.state;
      const runTiming = state?.runTiming ?? child.runTiming;
      const finalOutput =
        child.unfinished || this.active(child)
          ? undefined
          : (state?.finalOutput ?? child.finalOutput);
      return {
        id: child.id,
        name: child.name,
        ...this.ancestry(entry, child),
        status: this.active(child)
          ? "working"
          : child.failure
            ? "failure"
            : (state?.status ?? child.finishedStatus ?? null),
        ...(child.task !== undefined ? { task: child.task } : {}),
        ...(child.binding ? { binding: child.binding } : {}),
        ...(child.purpose ? { purpose: child.purpose } : {}),
        ...((child.executor?.enforcement ?? child.enforcement)
          ? { enforcement: child.executor?.enforcement ?? child.enforcement }
          : {}),
        ...((child.executor?.effectiveProfile ?? child.effectiveProfile)
          ? { effectiveProfile: child.executor?.effectiveProfile ?? child.effectiveProfile }
          : {}),
        output: state?.output ?? child.output ?? "",
        ...(finalOutput !== undefined ? { finalOutput } : {}),
        ...(child.failure ? { error: child.failure } : {}),
        ...(child.fileKey ? { sessionFile: child.fileKey } : {}),
        ...(child.closedAt !== undefined ? { finishedAt: child.closedAt } : {}),
        hidden: expired || this.hiddenRow(entry, child),
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
    let state = executor.state;
    if (entry.role === "subagent" && (entry.failure || entry.unfinished)) {
      const { finalOutput, result, attention: _attention, ...observed } = state;
      state = {
        ...observed,
        status: "failure",
        error: entry.failure ?? "The delegated result is incomplete.",
        pendingMessages: [],
        ...(!entry.unfinished && finalOutput !== undefined ? { finalOutput } : {}),
        result: {
          id: before?.state.result?.id ?? result?.id ?? crypto.randomUUID(),
          outcome: entry.unfinished ? "unfinished" : "error",
          completedAt: Date.now(),
          ...(entry.request ? { request: entry.request } : {}),
        },
      };
    }
    const sessionFile = entry.fileKey ?? executor.sessionFile;
    const telemetry = before?.state.telemetry ?? state.telemetry;
    const interrupted = state.status === "working";
    const record: SessionRecord = {
      id: entry.id,
      name: entry.name,
      ...((executor.effectiveProfile ?? entry.effectiveProfile)
        ? { effectiveProfile: executor.effectiveProfile ?? entry.effectiveProfile }
        : {}),
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
              result: {
                id: crypto.randomUUID(),
                outcome: "unfinished",
                completedAt: Date.now(),
              },
            }
          : {}),
      },
      subagents,
    };

    if (this.scopeFenced(scope)) {
      this.noteRecordCandidate(record);
    } else {
      this.retired.set(sessionRecordKey(record), record);
    }

    return record;
  }

  // Optional ancestry keeps older snapshots valid: absent fields mean a direct root child.
  private ancestry(
    entry: OpenExecution,
    child: Execution,
  ): { ownerId: string; rootId: string; depth: number } {
    return {
      ownerId: child.owner?.id ?? entry.id,
      rootId: entry.id,
      depth: child.depth ?? 1,
    };
  }

  // A hidden batch hides its runs' descendants too.
  private hiddenRow(entry: OpenExecution, child: Execution): boolean {
    for (let node: Execution | undefined = child; node && node !== entry; node = node.owner)
      if (entry.hiddenChildren?.has(node.id)) return true;
    return false;
  }

  private visibleChildren(entry: OpenExecution): Subagent[] {
    const hidden = new Set(
      [...this.descendants(entry)].filter((child) => this.hiddenRow(entry, child)).map((c) => c.id),
    );
    return this.children(entry).filter((child) => !hidden.has(child.id));
  }

  private children(entry: OpenExecution): Subagent[] {
    const owned = [...this.descendants(entry)].map((child): Subagent => {
      const state = child.executor?.state;
      const request = state?.request ?? child.request;
      const runTiming = state?.runTiming ?? child.runTiming;
      const progress = (child.channel?.progress ?? child.progress)?.at(-1)?.message;

      return {
        id: child.id,
        name: child.name,
        ...this.ancestry(entry, child),
        ...(progress ? { progress: progress.slice(0, 512) } : {}),
        status: this.active(child)
          ? "working"
          : child.failure
            ? "failure"
            : (state?.status ?? child.finishedStatus ?? null),
        ...(child.channel?.questions.length ? { phase: "waiting" as const } : {}),
        ...(child.closedAt !== undefined ? { finishedAt: child.closedAt } : {}),
        ...(request ? { request } : {}),
        ...(runTiming ? { runTiming } : {}),
      };
    });

    // Pi extension children are display observations, never handles owned by this registry.
    return [...owned, ...(entry.executor?.state.externalSubagents ?? [])];
  }

  restore(record: SessionRecord): Promise<Result<void, ExpectedError>> {
    if (record.lifecycle === "closed" || record.role === "subagent") {
      return Promise.resolve(ok(undefined));
    }

    const scope: SessionScope =
      record.scope?.kind === "chat"
        ? { kind: "chat" }
        : { kind: "code", worktreeId: record.worktreeId! };

    return this.trackScoped(scope, this.restoreOnce(record, scope));
  }

  private async restoreOnce(
    record: SessionRecord,
    scope: SessionScope,
  ): Promise<Result<void, ExpectedError>> {
    if (this.scopeFenced(scope)) {
      return err(this.scopeRemoved());
    }

    const epoch = this.scopeEpoch(scope);

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

    // A record read for a removed scope generation must not reopen in its replacement.
    if (!this.scopeCurrent(scope, epoch)) {
      return err(this.scopeRemoved());
    }

    const created = await this.createScoped(
      scope,
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
    const restoredNodes = new Map<string, Execution>();
    for (const child of record.ownedSubagents ??
      record.subagents.filter((child) => child.source !== "pi")) {
      const saved = "output" in child ? child : undefined;
      // Legacy records have no ancestry and attach to the root. Unknown owners do too.
      const owner =
        child.ownerId && child.ownerId !== entry.id ? restoredNodes.get(child.ownerId) : undefined;
      if (saved?.hidden && !owner) {
        entry.hiddenChildren ??= new Set();
        entry.hiddenChildren.add(child.id);
      }
      const node: Execution = {
        ...(saved
          ? {
              output: saved.output,
              ...(saved.finalOutput !== undefined ? { finalOutput: saved.finalOutput } : {}),
              progress: saved.progress,
              ...(saved.binding ? { binding: Object.freeze({ ...saved.binding }) } : {}),
              ...(saved.purpose ? { purpose: saved.purpose } : {}),
              ...(saved.effectiveProfile ? { effectiveProfile: saved.effectiveProfile } : {}),
              ...(saved.enforcement ? { enforcement: saved.enforcement } : {}),
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
        root: entry,
        depth: owner ? (owner.depth ?? 1) + 1 : 1,
        ...(owner ? { owner } : { owner: entry }),
      };
      restoredNodes.set(node.id, node);
      if (owner) (owner.children ??= new Map()).set(node.id, node);
      else entry.children.set(node.id, node);
    }

    this.emit();

    return ok(undefined);
  }

  create(
    worktreeId: string,
    sessionFile?: string,
    identity?: {
      readonly id: string;
      readonly name: string;
      readonly managed?: boolean;
    },
  ): Promise<Result<string, ExpectedError>> {
    return this.createScoped({ kind: "code", worktreeId }, sessionFile, identity);
  }

  createChat(
    sessionFile?: string,
    identity?: {
      readonly id: string;
      readonly name: string;
      readonly managed?: boolean;
    },
  ): Promise<Result<string, ExpectedError>> {
    return this.createScoped({ kind: "chat" }, sessionFile, identity);
  }

  private createScoped(
    scope: SessionScope,
    sessionFile?: string,
    identity?: {
      readonly id: string;
      readonly name: string;
      readonly managed?: boolean;
    },
  ): Promise<Result<string, ExpectedError>> {
    return this.trackScoped(scope, this.createScopedOnce(scope, sessionFile, identity));
  }

  private async createScopedOnce(
    scope: SessionScope,
    sessionFile?: string,
    identity?: {
      readonly id: string;
      readonly name: string;
      readonly managed?: boolean;
    },
  ): Promise<Result<string, ExpectedError>> {
    if (scope.kind !== this.registryScope) {
      return err(new InputError("Session scope does not belong to this registry."));
    }
    if (this.shuttingDown) {
      return err(this.stopping());
    }
    if (this.scopeFenced(scope)) {
      return err(this.scopeRemoved());
    }

    const epoch = this.scopeEpoch(scope);

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
    if (!this.scopeCurrent(scope, epoch)) {
      return err(this.scopeRemoved());
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
        ...this.rootFactoryOptions(id, generation, scope, worktree?.path ?? homedir()),
        ...(requestedFile ? { sessionFile: requestedFile } : {}),
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
      result = await this.initialize(entry, ready, requestedFile, epoch);
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
    requestedFile: string | undefined,
    epoch: number,
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
    if (!this.scopeCurrent(entry.scope, epoch)) {
      return err(
        new CancelledError("Session creation was cancelled because its worktree was removed."),
      );
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
    const workflow = await this.openTaskWorkflow(entry);
    if (!workflow.ok) return workflow;
    if (workflow.value) {
      const recovered = await this.commitTaskWorkflow(entry, workflow.value, (doc) => {
        // Continuations share the same scope, registry and host process. Pending launches
        // count too: admission commits before a live Execution reserves its slot.
        const live = [...this.entries.values()].some((root) =>
          [...this.descendants(root)].some(
            (run) => run.binding?.workflowId === doc.workflowId && this.active(run),
          ),
        );
        const starting = [...this.startingRuns.values()].some((root) =>
          doc.members.some((member) => member.conversationId === root.executor?.savedSessionId),
        );
        return live || starting
          ? ok({ doc, effects: [], outcome: { kind: "duplicate" } })
          : recoverWorkflow(doc, { eventKey: `recover:${entry.generation}`, at: Date.now() });
      });
      if (!recovered.ok) return recovered;
      entry.phase = "open";
      const routed = this.routeTaskWorkflow(entry, recovered.value.doc);
      if (!routed.ok) return routed;
    } else {
      entry.phase = "open";
    }
    const schedulerOwnedElsewhere =
      workflow.value &&
      [...this.entries.values()].some(
        (other) =>
          other !== entry &&
          other.schedulerOwnership &&
          workflow.value!.doc.members.some(
            (member) => member.conversationId === other.executor?.savedSessionId,
          ),
      );
    if (
      entry.executor?.workflowScheduler &&
      workflow.value?.doc.version === 2 &&
      !schedulerOwnedElsewhere
    ) {
      const interrupted = await this.interruptOrphanedPlanningSchedulers(entry, workflow.value.doc);
      if (!interrupted.ok) return interrupted;
    }
    this.emit();

    return ok(entry.id);
  }

  private openTaskWorkflow(
    root: OpenExecution,
  ): Promise<Result<OpenedWorkflow | null, ExpectedError>> {
    const executor = root.executor;
    return executor?.sessionFile
      ? openWorkflow(root.fileKey ?? executor.sessionFile, {
          conversationId: executor.savedSessionId,
          cwd: root.worktree?.path ?? homedir(),
        })
      : Promise.resolve(ok(null));
  }

  private workflowMembers(root: OpenExecution, doc: WorkflowDocument): OpenExecution[] {
    return [...this.entries.values()].filter(
      (memberRoot) =>
        memberRoot.scope.kind === root.scope.kind &&
        (root.scope.kind === "chat" ||
          (memberRoot.scope.kind === "code" &&
            memberRoot.scope.worktreeId === root.scope.worktreeId)) &&
        doc.members.some(
          (member) =>
            member.conversationId === memberRoot.executor?.savedSessionId &&
            member.sessionFile === memberRoot.fileKey &&
            member.cwd === (memberRoot.worktree?.path ?? homedir()),
        ),
    );
  }

  private routeTaskWorkflow(
    root: OpenExecution,
    doc: WorkflowDocument,
  ): Result<void, WorkflowError> {
    const recipients: TaskRecipient[] = [];
    // Only canonical workflow members in this scope receive observation notices.
    for (const memberRoot of this.workflowMembers(root, doc)) {
      const addMember = (node: Execution) => {
        const executor = node.executor;
        if (!executor?.notifySubagent) return;
        if (
          node !== memberRoot &&
          (!node.binding || !authorizeTaskBinding(doc, node.binding, node.name).ok)
        )
          return;
        recipients.push({
          id: `${memberRoot.generation}:${node.id}`,
          root: node === memberRoot,
          workflowId: doc.workflowId,
          ...(node.binding ? { binding: node.binding, profile: node.name } : {}),
          current: () =>
            this.ownerCurrent(node, memberRoot, memberRoot.generation) &&
            (node === memberRoot || !node.settled),
          notify: (notice, current, delivered) =>
            executor.notifySubagent!(notice, current, delivered),
        });
      };
      addMember(memberRoot);
      for (const node of this.descendants(memberRoot)) addMember(node);
    }
    return this.taskRouting.redeliver(doc, recipients);
  }

  private async commitTaskWorkflow(
    root: OpenExecution,
    opened: OpenedWorkflow,
    mutate: (doc: WorkflowDocument) => WorkflowPolicyResult,
    committed?: (doc: WorkflowDocument) => void,
  ) {
    const result = await mutateWorkflow(opened.location, opened.doc.origin, (doc) =>
      doc ? mutate(doc) : err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared.")),
    );
    if (result.ok) {
      committed?.(result.value.doc);
      entrySummary(root, result.value.doc);
      const routed = this.routeTaskWorkflow(root, result.value.doc);
      if (!routed.ok) return routed;
    }
    return result;
  }

  /** Internal host controls; user-command provenance is enforced by the command boundary. */
  async controlPlanningScheduler(
    sessionId: string,
    command: PlanningSchedulerControl,
  ): Promise<Result<void, ExpectedError>> {
    const selected = this.requireOpen(sessionId);
    if (!selected.ok) return selected;
    const root = selected.value;
    // Serialize controls through shutdown, including starts that precede the first declaration.
    const pending = (root.schedulerControl ?? Promise.resolve(ok(undefined))).then(() =>
      this.applyPlanningSchedulerControl(root, command),
    );
    root.schedulerControl = pending;
    try {
      return await pending;
    } finally {
      if (root.schedulerControl === pending) delete root.schedulerControl;
    }
  }

  private async applyPlanningSchedulerControl(
    root: OpenExecution,
    command: PlanningSchedulerControl,
  ): Promise<Result<void, ExpectedError>> {
    if (!this.ownerCurrent(root, root, root.generation)) return err(new CancelledError());
    const ownership = root.schedulerOwnership;
    if (command.kind !== "started" && ownership?.invocationId !== command.invocationId) {
      // Never redirect a control to another live owner. Without one, a known durable
      // invocation may be reconciled before cancellation, just as after a restart.
      if (ownership || !["restarted", "cancelled", "resumed"].includes(command.kind))
        return ok(undefined);
    }
    if (command.kind === "started" && root.executionOwnership)
      return err(
        new WorkflowError(
          "WORKFLOW_CONFLICT",
          "Cancel execution before starting a planning scheduler.",
        ),
      );
    if (command.kind === "started" && ownership)
      return ownership.invocationId === command.invocationId
        ? ok(undefined)
        : err(
            new WorkflowError(
              "WORKFLOW_CONFLICT",
              "This conversation already owns a planning scheduler; cancel it before starting another plan.",
            ),
          );
    const configuration = root.executor?.workflowScheduler;
    if (!ownership && !configuration) return ok(undefined);
    const opened = await this.openTaskWorkflow(root);
    if (!opened.ok) return opened;
    if (command.kind === "started") {
      if (
        opened.value &&
        this.workflowMembers(root, opened.value.doc).some(
          (other) => other !== root && (other.schedulerOwnership || other.executionOwnership),
        )
      )
        return err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            "Another open conversation owns this workflow scheduler; cancel or close it before starting a new plan.",
          ),
        );
      // Reopen may have happened while OFF. Reconcile v2 orphans now, before a new
      // invocation can see their active admission keys; never migrate merely to recover.
      if (opened.value) {
        const recovered = await this.interruptOrphanedPlanningSchedulers(root, opened.value.doc);
        if (!recovered.ok) return recovered;
      }
      const driver = this.planningScheduler(root, configuration!, command.invocationId);
      let initialization: Promise<Result<void, ExpectedError>> | undefined;
      const initialize = () => {
        initialization ??= driver.control(command).then((result) => {
          if (!result.ok) initialization = undefined;
          return result;
        });
        return initialization;
      };
      if (opened.value) {
        const started = await initialize();
        if (!started.ok) {
          await driver.shutdown();
          return started;
        }
      }
      root.schedulerOwnership = {
        invocationId: command.invocationId,
        state: "active",
        driver,
        initialize,
      };
      return ok(undefined);
    }
    if (!ownership) {
      // Unknown/historical controls are no-ops, and a sibling's live owner is authoritative.
      const doc = opened.value?.doc;
      if (
        doc?.version !== 2 ||
        this.workflowMembers(root, doc).some((member) => member.schedulerOwnership)
      )
        return ok(undefined);
      const invocation = doc.scheduler?.invocations.find(
        (item) => item.id === command.invocationId && item.kind === "plan",
      );
      if (!invocation) return ok(undefined);
      if (command.kind === "resumed") {
        if (invocation.state !== "paused" || !configuration)
          return err(
            new WorkflowError(
              "WORKFLOW_CONFLICT",
              "Only paused planning invocations can be resumed with the scheduler enabled.",
            ),
          );
        if (this.workflowMembers(root, doc).some((member) => member.executionOwnership))
          return err(
            new WorkflowError("WORKFLOW_CONFLICT", "Execution currently owns this workflow."),
          );
        const recovered = await this.interruptOrphanedPlanningSchedulers(root, doc, invocation.id);
        if (!recovered.ok) return recovered;
        const driver = this.planningScheduler(root, configuration, invocation.id);
        root.schedulerOwnership = {
          invocationId: invocation.id,
          state: "active",
          driver,
          initialize: async () => ok(undefined),
        };
        const resumed = await driver.control(command);
        if (!resumed.ok) {
          await driver.shutdown();
          delete root.schedulerOwnership;
        }
        return resumed;
      }
      if (
        ["cancelled", "completed"].includes(invocation.state) &&
        !Object.values(doc.scheduler!.admissions).some(
          (item) => item.invocationId === invocation.id && activeAdmission(item.state),
        )
      )
        return ok(undefined);
      const recovered = await this.interruptOrphanedPlanningSchedulers(
        root,
        doc,
        command.invocationId,
      );
      if (!recovered.ok || command.kind === "restarted") return recovered;
      const recovery = this.planningScheduler(
        root,
        { profiles: () => ok([]) },
        command.invocationId,
      );
      const cancelled = await recovery.control(command);
      await recovery.shutdown();
      return cancelled;
    }
    if (command.kind !== "cancelled") return ownership.driver.control(command);
    ownership.state = "cancelling";
    // A declaration can commit before lazy initialization fails. Establish the owner's
    // durable invocation without profiles or new launches before reconciling its cancel.
    const initialized = opened.value ? await ownership.initialize() : ok(undefined);
    const controlled =
      initialized.ok && opened.value ? await ownership.driver.control(command) : initialized;
    if (!controlled.ok) {
      ownership.state = "cleanup-uncertain";
      return controlled;
    }
    // Only confirmed cleanup of this invocation, followed by driver shutdown, releases guards.
    await ownership.driver.shutdown();
    delete root.schedulerOwnership;
    return ok(undefined);
  }

  private async interruptOrphanedPlanningSchedulers(
    root: OpenExecution,
    doc: WorkflowDocument,
    invocationId?: string,
  ): Promise<Result<void, ExpectedError>> {
    if (doc.version !== 2) return ok(undefined);
    for (const invocation of doc.scheduler?.invocations ?? []) {
      if (
        invocation.kind !== "plan" ||
        (invocationId && invocation.id !== invocationId) ||
        (invocation.state !== "active" &&
          !Object.values(doc.scheduler!.admissions).some(
            (item) => item.invocationId === invocation.id && activeAdmission(item.state),
          ))
      )
        continue;
      // Recovery must not require current profiles, launch work or replay an old plan.
      const recovery = this.planningScheduler(root, { profiles: () => ok([]) }, invocation.id);
      const recovered = await recovery.control({ kind: "restarted", invocationId: invocation.id });
      await recovery.shutdown();
      if (!recovered.ok) return recovered;
    }
    return ok(undefined);
  }

  private planningScheduler(
    root: OpenExecution,
    configuration: NonNullable<SessionExecutor["workflowScheduler"]>,
    invocationId: string,
  ): PlanningSchedulerDriver {
    const report = (error: ExpectedError) => {
      if (error.code !== "CANCELLED")
        console.warn(`[radian:scheduler] ${error.code}: ${error.message}`);
    };
    const cancelling = () =>
      root.schedulerOwnership?.invocationId === invocationId &&
      root.schedulerOwnership.state !== "active";
    return new PlanningSchedulerDriver({
      // The provider is captured at start: later setting changes cannot revoke this owner.
      profiles: () => (cancelling() ? ok([]) : configuration.profiles()),
      runs: () =>
        [...this.descendants(root)].map((run) => ({
          id: run.id,
          ...(run.operationId ? { operationId: run.operationId } : {}),
          active: this.active(run),
        })),
      commit: async (event, runs) => {
        if (!this.ownerCurrent(root, root, root.generation) || event.invocationId !== invocationId)
          return err(new CancelledError());
        const opened = await this.openTaskWorkflow(root);
        if (!opened.ok) return opened;
        if (!opened.value)
          return err(new WorkflowError("WORKFLOW_NOT_FOUND", "No declared planning workflow."));
        let intents: SchedulerIntent[] = [];
        const committed = await mutateWorkflow(
          opened.value.location,
          opened.value.doc.origin,
          (doc) => {
            if (!doc) return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared."));
            const reduced = schedule(doc, runs, {
              ...event,
              capacity: delegationLimits.activeDescendants,
              retainedCapacity: delegationLimits.retainedRuns,
            });
            if (!reduced.ok) return reduced;
            intents = reduced.value.intents;
            return ok({ doc: reduced.value.doc, effects: [], outcome: { kind: "applied" } });
          },
          { requireVersion: 2 },
        );
        if (committed.ok) entrySummary(root, committed.value.doc);
        return committed.ok ? ok({ doc: committed.value.doc, intents }) : committed;
      },
      launch: async (operationId, admission, profile) => {
        const existing = [...this.descendants(root)].find((run) => run.operationId === operationId);
        if (existing) return ok(existing.id);
        const opened = await this.openTaskWorkflow(root);
        if (!opened.ok) return opened;
        const task = opened.value?.doc.tasks[admission.taskId];
        if (!task || admission.role !== "lead" || admission.effectiveProfile.purpose !== "planning")
          return err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Only read-only plan leads may be scheduled.",
            ),
          );
        return this.spawnChild(
          root,
          root,
          root.generation,
          profile.name,
          [
            "Read-only planning scheduler mode. Investigate only; do not edit files, run tests/builds, install or implement. Publish a complete reviewed plan with radian-task publish-plan; return only its ref and bounded summary. Ask your owner for material decisions. Descendants must remain planning-only.",
            `Goal: ${opened.value!.doc.manifest!.goal}`,
            `Branch: ${task.id}: ${task.title}\nScope: ${task.scope}`,
            `Frozen prerequisites: ${admission.frozenInputs.join(", ") || "none"}. Retrieve only exact ref@revision bodies through radian-task status.`,
          ].join("\n\n"),
          {
            background: true,
            purpose: "planning",
            profile: {
              ...profile,
              ...(admission.effectiveProfile.model
                ? { model: admission.effectiveProfile.model }
                : {}),
              ...(admission.effectiveProfile.thinking
                ? { thinking: admission.effectiveProfile.thinking }
                : {}),
              effectiveProfile: admission.effectiveProfile,
            },
            requestedBinding: { id: task.id, role: "lead" },
            schedulerAdmission: { operationId, admission },
          },
        );
      },
      stop: async (operationId) => {
        const run = [...this.descendants(root)].find((item) => item.operationId === operationId);
        return run ? this.closeExecution(run) : ok(undefined);
      },
      report,
      unexpected: (error) => {
        reportUnexpected(error, "planning scheduler");
      },
    });
  }

  private async admitTaskRepair(
    root: OpenExecution,
    opened: OpenedWorkflow,
    binding: WorkflowBinding,
    requested: TaskSpawnBinding,
    execution: Execution,
  ): Promise<Result<RepairTarget | undefined, ExpectedError>> {
    let defectId: string | undefined;
    const result = await this.commitTaskWorkflow(root, opened, (doc) => {
      const authorized = authorizeTaskBinding(
        doc,
        binding,
        doc.tasks[binding.taskId]?.implementer?.profile ?? "",
      );
      if (!authorized.ok) return authorized;
      const allowed = guardImplementation(doc, binding.taskId);
      if (!allowed.ok) return allowed;
      if (requested.attemptId)
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            "Implementer attempt IDs are assigned by the host admission boundary.",
          ),
        );
      const defects = Object.values(doc.defects).filter(
        (item) =>
          item.responsibleTasks.includes(binding.taskId) &&
          item.state !== "resolved" &&
          item.state !== "cancelled",
      );
      if (!requested.defectId && defects.length > 1)
        return err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            `Choose a binding defectId: ${defects.map((defect) => defect.id).join(", ")}.`,
          ),
        );
      const defect = requested.defectId
        ? defects.find((defect) => defect.id === requested.defectId)
        : defects[0];
      if (requested.defectId && !defect)
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            "Repair target is not an unresolved defect of this task.",
          ),
        );
      if (!defect) return ok({ doc, effects: [], outcome: { kind: "duplicate" } });
      defectId = defect.id;
      const active = defect.attempts.find(
        (attempt) => attempt.status === "authorized" || attempt.status === "submitted",
      );
      const admission: WorkflowPolicyResult =
        active?.status === "authorized" &&
        active.origin === "automated" &&
        active.submittedTaskId === binding.taskId
          ? ok({ doc, effects: [], outcome: { kind: "duplicate", ref: active.id } })
          : admitRepair(doc, {
              binding,
              defectId: defect.id,
              attemptId: crypto.randomUUID(),
              eventKey: `admit:${crypto.randomUUID()}`,
              at: Date.now(),
            });
      if (!admission.ok) return admission;
      const attemptId = admission.value.outcome.ref;
      if (attemptId) {
        // This decision and claim run synchronously inside the serialized durable mutation.
        const key = JSON.stringify([doc.workflowId, defect.id, attemptId]);
        const holder = this.repairClaims.get(key);
        if (holder && holder !== execution)
          return err(
            new WorkflowError(
              "WORKFLOW_CONFLICT",
              `Attempt ${attemptId} is already running in run ${holder.id}`,
            ),
          );
        this.repairClaims.set(key, execution);
        execution.repairClaim = key;
      }
      return admission;
    });
    if (!result.ok) return result;
    return ok(
      defectId && result.value.outcome.ref
        ? Object.freeze({ defectId, attemptId: result.value.outcome.ref })
        : undefined,
    );
  }

  private releaseRepairClaim(execution: Execution): void {
    const key = execution.repairClaim;
    if (key && this.repairClaims.get(key) === execution) this.repairClaims.delete(key);
    delete execution.repairClaim;
  }

  private boundAuthority(execution: Execution): Execution | undefined {
    for (let node: Execution | undefined = execution; node; node = node.owner)
      if (node.binding) return node;
    return undefined;
  }

  private checkExecutionConsent(
    root: OpenExecution,
    doc: WorkflowDocument,
    invocationId: string,
  ): Result<void, WorkflowError> {
    const owner = root.executionOwnership;
    const invocation =
      doc.version === 2
        ? doc.scheduler?.invocations.find((item) => item.id === invocationId)
        : undefined;
    const receipt =
      doc.version === 2 && invocation?.consentId
        ? doc.scheduler?.consents[invocation.consentId]
        : undefined;
    if (
      !owner ||
      owner.cancelling ||
      owner.invocationId !== invocationId ||
      !invocation ||
      !["active", "paused"].includes(invocation.state) ||
      !receipt ||
      receipt.state !== "confirmed"
    )
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Execution consent no longer authorizes this run.",
        ),
      );
    const profiles = owner.profiles();
    if (!profiles.ok)
      return err(
        new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Execution profiles are unavailable.", {
          cause: profiles.error,
        }),
      );
    return validateExecutionConsent(
      doc,
      receipt,
      root.worktree?.path ?? homedir(),
      Object.fromEntries(
        profiles.value.map((profile) => [profile.name, executionProfileSnapshot(profile)]),
      ),
    );
  }

  private checkTaskWrite(doc: WorkflowDocument, execution: Execution): Result<void, ExpectedError> {
    const actor = this.boundAuthority(execution);
    if (!actor?.binding)
      return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "No bound write authority."));
    const binding = actor.binding;
    const authorized = authorizeTaskBinding(doc, binding, actor.name);
    if (!authorized.ok) return authorized;
    if (execution.purpose || actor.purpose || binding.purpose)
      return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Purpose runs are read-only."));
    if (actor.writeClosed)
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Artifact submitted; a new authorized attempt is required",
        ),
      );
    // QA needs bash for tests. Product-code editing remains a role instruction, not an OS sandbox.
    if (binding.role === "verifier") return ok(undefined);
    const allowed = guardImplementation(doc, binding.taskId);
    if (!allowed.ok) return allowed;
    if (binding.role !== "implementer") return ok(undefined);
    if (actor.repairTarget) {
      const attempt = doc.defects[actor.repairTarget.defectId]?.attempts.find(
        (item) => item.id === actor.repairTarget!.attemptId,
      );
      return attempt?.status === "authorized" &&
        attempt.origin === "automated" &&
        attempt.submittedTaskId === binding.taskId &&
        actor.repairClaim &&
        this.repairClaims.get(actor.repairClaim) === actor
        ? ok(undefined)
        : err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Repair attempt no longer authorizes writes.",
            ),
          );
    }
    const task = doc.tasks[binding.taskId]!;
    const unresolved = Object.values(doc.defects).some(
      (defect) =>
        defect.responsibleTasks.includes(binding.taskId) &&
        defect.state !== "resolved" &&
        defect.state !== "cancelled",
    );
    if (
      unresolved ||
      (task.verification.state === "awaiting-qa" && actor.submittedRevision !== undefined)
    )
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "A new authorized implementation run is required.",
        ),
      );
    return ok(undefined);
  }

  private async authorizeTaskWrite(
    execution: Execution,
    root: OpenExecution,
    generation: string,
  ): Promise<Result<void, ExpectedError>> {
    if (!this.ownerCurrent(execution, root, generation) || execution.closing || execution.settled)
      return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Run is no longer active."));
    const opened = await this.openTaskWorkflow(root);
    if (!opened.ok) return opened;
    if (!opened.value) return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared."));
    if (!this.ownerCurrent(execution, root, generation) || execution.closing || execution.settled)
      return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Run is no longer active."));
    if (execution.operationId && opened.value.doc.version === 2) {
      const admission = opened.value.doc.scheduler?.admissions[execution.operationId];
      const invocation = opened.value.doc.scheduler?.invocations.find(
        (item) => item.id === admission?.invocationId,
      );
      if (invocation?.kind === "execute") {
        const allowed = this.checkExecutionConsent(root, opened.value.doc, invocation.id);
        if (!allowed.ok) return allowed;
      }
    }
    return this.checkTaskWrite(opened.value.doc, execution);
  }

  private async coordinateTask(
    rootId: string,
    generation: string,
    node: Execution | undefined,
    command: TaskCommand,
    callId: string,
    signal?: AbortSignal,
    knownProfiles: string[] = [],
  ): Promise<Result<unknown, ExpectedError>> {
    const selected = this.requireOpen(rootId);
    if (!selected.ok) return selected;
    const root = selected.value;
    const actor = node ?? root;
    if (signal?.aborted || !this.ownerCurrent(actor, root, generation))
      return err(new CancelledError());
    const opened = await this.openTaskWorkflow(root);
    if (!opened.ok) return opened;
    // This provenance is host-owned model authority, never user-command authority.
    const provenance = { kind: "root-model" as const, runId: actor.id };
    const event = { eventKey: `${provenance.runId}:${callId}`, at: Date.now() };
    const binding = actor.binding;
    const isRoot = actor === root;
    const authorize = (doc: WorkflowDocument): Result<void, WorkflowError> => {
      if (isRoot) return ok(undefined);
      return binding
        ? authorizeTaskBinding(doc, binding, actor.name)
        : err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Only roots and bound runs may use radian-task.",
            ),
          );
    };
    if (!root.executor?.sessionFile || (!opened.value && !(isRoot && command.action === "declare")))
      return err(new WorkflowError("WORKFLOW_NOT_FOUND", "This conversation has no workflow."));
    if (command.action === "status") {
      const doc = opened.value!.doc;
      const authorized = authorize(doc);
      if (!authorized.ok) return authorized;
      if (command.detail === "handoff") {
        const defect = command.id ? doc.defects[command.id] : undefined;
        if (!defect)
          return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Handoff requires a defect ID."));
        if (
          !isRoot &&
          (!binding || !defect.responsibleTasks.some((id) => isTaskLead(doc, binding, id)))
        )
          return err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Only a responsible lead/root may request this handoff.",
            ),
          );
        return renderHumanHandoff(doc, defect.id);
      }
      if (command.artifact) {
        const [artifactId, revision] = command.artifact.split("@");
        const artifact = artifactId ? doc.artifacts[artifactId] : undefined;
        const denied = () =>
          err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Only the owning lead/root or a dependent run with this frozen input revision may request this artifact.",
            ),
          );
        if (!artifact) return denied();
        const ownsArtifact = isRoot || (binding && isTaskLead(doc, binding, artifact.taskId));
        if (!ownsArtifact) {
          const inputs = actor.planInputs;
          const task = binding ? doc.tasks[binding.taskId] : undefined;
          const frozenInput =
            artifact &&
            task &&
            inputs &&
            !!revision &&
            !/\D/.test(revision) &&
            command.artifact === `${artifactId}@${revision}` &&
            inputs.dependencies.some(
              (input) => input.artifactId === artifactId && input.revision === Number(revision),
            ) &&
            (task.dependsOn.includes(artifact.taskId) ||
              (actor.operationId &&
                doc.version === 2 &&
                doc.scheduler?.admissions[actor.operationId]?.frozenInputs.includes(
                  command.artifact,
                ) &&
                this.checkExecutionConsent(
                  root,
                  doc,
                  doc.scheduler.admissions[actor.operationId]!.invocationId!,
                ).ok));
          if (!frozenInput) return denied();
          if (task.declaredRevision !== undefined && inputs.boundRevision < task.declaredRevision)
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Binding predates the current declaration; respawn the lead.",
              ),
            );
        }
        const item = revision
          ? artifact.revisions.find((item) => item.revision === Number(revision))
          : artifact.revisions.at(-1);
        return item
          ? ok(item.body)
          : err(new WorkflowError("WORKFLOW_NOT_FOUND", "Artifact revision not found."));
      }
      const status = renderWorkflowStatus(doc, command.id).slice(0, 16000);
      if (
        !isRoot &&
        binding &&
        actor.planInputs &&
        (!command.id || command.id === binding.taskId)
      ) {
        const frozen = renderFrozenPlanInputs(doc, binding.taskId, actor.planInputs);
        return ok(`${status.slice(0, 16000 - frozen.length - 2)}\n\n${frozen}`);
      }
      return ok(status);
    }
    const mutate = (doc: WorkflowDocument): WorkflowPolicyResult => {
      if (actor.operationId && doc.version === 2) {
        const admission = doc.scheduler?.admissions[actor.operationId];
        const invocation = doc.scheduler?.invocations.find(
          (item) => item.id === admission?.invocationId,
        );
        if (invocation?.kind === "execute") {
          const allowed = this.checkExecutionConsent(root, doc, invocation.id);
          if (!allowed.ok) return allowed;
          if (
            binding?.role === "verifier" &&
            "revision" in command &&
            command.revision !== admission?.submittedRevision
          )
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Scheduled QA may only judge its frozen submitted revision.",
              ),
            );
        }
      }
      const authorized = authorize(doc);
      if (!authorized.ok) return authorized;
      if (actor.purpose && !["analysis", "publish-plan"].includes(command.action))
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            "Read-only runs may only inspect status and publish plans or analysis.",
          ),
        );
      const denied = () =>
        err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            "This action requires the current task role or owning lead/root.",
          ),
        );
      const owns = (taskId: string) => isRoot || (binding && isTaskLead(doc, binding, taskId));
      switch (command.action) {
        case "finding":
          return binding?.role === "verifier"
            ? recordFinding(doc, { ...command, ...event, binding })
            : denied();
        case "verdict": {
          if (binding?.role !== "verifier") return denied();
          const target = actor.repairTarget;
          if (
            target &&
            ((command.defectId && command.defectId !== target.defectId) ||
              (command.attemptId && command.attemptId !== target.attemptId))
          )
            return denied();
          return recordVerdict(doc, { ...command, ...target, ...event, binding });
        }
        case "submit": {
          if (binding?.role !== "implementer") return denied();
          if (actor.writeClosed)
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Artifact submitted; a new authorized attempt is required",
              ),
            );
          const allowed = guardImplementation(doc, binding.taskId);
          if (!allowed.ok) return allowed;
          const target = actor.repairTarget;
          if (
            (target &&
              ((command.defectId && command.defectId !== target.defectId) ||
                (command.attemptId && command.attemptId !== target.attemptId))) ||
            (!target && (command.defectId || command.attemptId))
          )
            return denied();
          return submitImplementation(doc, { ...command, ...target, ...event, binding });
        }
        case "analysis":
          return binding?.role === "lead"
            ? recordAnalysis(doc, { ...command, ...event, binding })
            : denied();
        case "publish-plan": {
          const task = binding ? doc.tasks[binding.taskId] : undefined;
          if (
            task?.declaredRevision !== undefined &&
            (actor.planInputs?.boundRevision ?? -1) < task.declaredRevision
          )
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Binding predates the current declaration; respawn the lead.",
              ),
            );
          return binding?.role === "lead"
            ? publishPlanArtifact(doc, {
                ...command,
                ...event,
                binding,
                author: { runId: actor.id, profile: actor.name, role: binding.role },
                ...(actor.planInputs
                  ? { reviewedDependencies: actor.planInputs.dependencies }
                  : {}),
              })
            : denied();
        }
        case "declare":
          return isRoot ? declareScope(doc, { ...command, ...event, knownProfiles }) : denied();
        case "assign":
          return owns(command.parentTaskId)
            ? declareSubtasks(doc, {
                ...event,
                parentTaskId: command.parentTaskId,
                subtasks: command.tasks,
                knownProfiles,
                ...(!isRoot && binding ? { binding } : {}),
              })
            : denied();
        case "reassign": {
          if (!owns(command.taskId)) return denied();
          if (!knownProfiles.includes(command.profile))
            return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Unknown assigned profile."));
          return reassign(doc, { ...command, ...event });
        }
        case "continue":
        case "split": {
          if (!owns(command.taskId)) return denied();
          if (
            [command.task.lead, command.task.implementer, command.task.verifier].some(
              (profile) => profile && !knownProfiles.includes(profile.profile),
            )
          )
            return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Unknown assigned profile."));
          return (command.action === "continue" ? continueTask : splitTask)(doc, {
            ...command,
            ...event,
          });
        }
      }
    };
    const result = opened.value
      ? await this.commitTaskWorkflow(root, opened.value, mutate, (doc) => {
          if (command.action === "submit" && binding?.role === "implementer") {
            // Close before notification delivery: a routing failure cannot reopen accepted writes.
            actor.writeClosed = true;
            actor.submittedRevision = doc.tasks[binding.taskId]!.artifactRevision;
          }
        })
      : await mutateWorkflow(
          { originSessionFile: root.executor!.sessionFile! },
          { conversationId: root.executor!.savedSessionId, cwd: root.worktree?.path ?? homedir() },
          (doc) =>
            mutate(
              doc ??
                createWorkflowDocument(
                  {
                    conversationId: root.executor!.savedSessionId,
                    cwd: root.worktree?.path ?? homedir(),
                    sessionFile: root.executor!.sessionFile!,
                  },
                  crypto.randomUUID(),
                  event.at,
                ),
            ),
        );
    if (!result.ok) return result;
    for (const member of this.workflowMembers(root, result.value.doc))
      member.executionOwnership?.driver.observe({ kind: "published" });
    if (command.action === "declare" && root.schedulerOwnership) {
      const started = await root.schedulerOwnership.initialize();
      if (!started.ok) return started;
    }
    if (
      ["declare", "assign", "reassign", "continue", "split", "publish-plan"].includes(
        command.action,
      )
    ) {
      // Binding generations can change from any canonical workflow member, not just
      // the conversation that owns admission. Settlement still gates replacement.
      for (const member of this.workflowMembers(root, result.value.doc)) {
        member.schedulerOwnership?.driver.observe({
          kind: command.action === "publish-plan" ? "published" : "declared",
        });
      }
    }
    if (command.action === "publish-plan") {
      const artifact = result.value.doc.artifacts[command.artifactId]?.revisions.at(-1);
      return ok({
        ref: result.value.outcome.ref,
        goal: command.plan.goal.slice(0, 512),
        taskCount: command.plan.tasks.length,
        deps: result.value.doc.tasks[binding!.taskId]!.dependsOn,
        warnings: command.review.warnings,
        summary: artifact?.summary,
      });
    }
    return ok({
      ...result.value.outcome,
      status: renderWorkflowStatus(result.value.doc, binding?.taskId).slice(0, 12000),
    });
  }

  async workflow(
    sessionId: string,
    conversationId: string,
    command: WorkflowCommand,
    provenance: UserCommandProvenance,
  ): Promise<Result<string, ExpectedError>> {
    const selected = this.modelOwner(sessionId, conversationId);
    if (!selected.ok) return selected;
    const root = selected.value;
    if (provenance.kind !== "user-command" || provenance.conversationId !== conversationId)
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Workflow controls require direct user-command provenance.",
        ),
      );
    const pending = (root.schedulerControl ?? Promise.resolve()).then(() =>
      this.applyWorkflowCommand(root, command, provenance),
    );
    root.schedulerControl = pending;
    try {
      const result = await pending;
      if (!result.ok) return result;
      const notice = await root.executor?.appendNotice?.(result.value);
      return notice && !notice.ok
        ? ok(
            `${result.value}\n[${notice.error.code}] Action accepted; transcript persistence unconfirmed.`,
          )
        : result;
    } finally {
      if (root.schedulerControl === pending) delete root.schedulerControl;
    }
  }

  private async applyWorkflowCommand(
    root: OpenExecution,
    command: WorkflowCommand,
    provenance: UserCommandProvenance,
  ): Promise<Result<string, ExpectedError>> {
    const opened = await this.openTaskWorkflow(root);
    if (!opened.ok) return opened;
    if (!opened.value)
      return err(new WorkflowError("WORKFLOW_NOT_FOUND", "This conversation has no workflow."));
    const doc = opened.value.doc;
    await this.retireCompletedExecution(root, doc);
    if (!doc.members.some((member) => member.conversationId === provenance.conversationId))
      return err(
        new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Conversation is not a workflow member."),
      );
    const status = (current: WorkflowDocument) =>
      [
        renderWorkflowStatus(current, command.kind === "status" ? command.id : undefined),
        ...(current.version === 2
          ? (current.scheduler?.invocations.map(
              (item) =>
                `Invocation ${item.id} | ${item.kind} | ${item.state}${item.consentId ? ` | consent ${item.consentId}` : ""}`,
            ) ?? [])
          : []),
        ...(current.version === 2
          ? Object.entries(current.tasks)
              .filter(([, task]) => task.schedule)
              .map(
                ([id, task]) => `${id} | ${task.schedule!.state} | ${task.schedule!.reason ?? "-"}`,
              )
          : []),
        ...(current.version === 2
          ? Object.entries(current.scheduler?.admissions ?? {}).map(
              ([operationId, item]) =>
                `Operation ${operationId} | ${item.taskId}/${item.role} | ${item.state} | profile ${item.effectiveProfile.id} | run ${item.runId ?? "not launched"}${item.stopReason ? ` | ${item.stopReason}` : ""}`,
            )
          : []),
        "Controls: /workflow status | pause [id] | resume [id] | cancel [id] | start <all|taskIds> [--auto-repair]",
        "Cancellation retains changes and artifacts; closing a view is not cancellation.",
      ]
        .join("\n")
        .slice(0, 60000);
    if (command.kind === "status") return ok(status(doc));
    const liveExecution = root.executionOwnership;
    const configuration =
      root.executor?.workflowScheduler ??
      (liveExecution
        ? { profiles: () => liveExecution.profiles() }
        : root.schedulerOwnership
          ? { profiles: () => ok([] as AgentProfile[]) }
          : undefined);
    if (!configuration)
      return err(
        new CapabilityError(
          "Enable radian.workflowScheduler='on' explicitly before controlling scheduled work.",
        ),
      );
    const profiles =
      command.kind === "pause" || command.kind === "cancel"
        ? ok([] as AgentProfile[])
        : configuration.profiles();
    if (!profiles.ok) return profiles;
    const snapshots = Object.fromEntries(
      profiles.value.map((profile) => [profile.name, executionProfileSnapshot(profile)]),
    );
    const worktree = root.worktree?.path ?? homedir();
    const persist = async (mutate: (current: WorkflowDocument) => WorkflowPolicyResult) =>
      mutateWorkflow(
        opened.value!.location,
        doc.origin,
        (current) =>
          current
            ? mutate(current)
            : err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared.")),
        { requireVersion: 2 },
      );
    if (command.kind === "start") {
      const preview = previewExecution(
        doc,
        command.tasks,
        worktree,
        snapshots,
        provenance,
        command.autoRepair,
        crypto.randomUUID(),
      );
      if (!preview.ok) return preview;
      const saved = await persist((current) => {
        if (current.version !== 2)
          return err(new WorkflowError("WORKFLOW_CONFLICT", "Expected v2 storage."));
        const valid = validateExecutionConsent(current, preview.value, worktree, snapshots);
        if (!valid.ok) return valid;
        current.scheduler ??= { invocations: [], admissions: {}, consents: {} };
        current.scheduler.consents[preview.value.id] = preview.value;
        current.revision++;
        return ok({ doc: current, effects: [], outcome: { kind: "applied" } });
      });
      return saved.ok ? renderConsent(preview.value, saved.value.doc, snapshots) : saved;
    }
    if (command.kind === "confirm") {
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.scope.kind === root.scope.kind &&
            entry.worktree?.path === root.worktree?.path &&
            (entry.executor?.busy || entry.executor?.state.status === "working"),
        )
      )
        return err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for model work in this worktree to settle before confirming execution.",
          ),
        );
      if (
        this.workflowMembers(root, doc).some(
          (member) => member.schedulerOwnership || member.executionOwnership,
        )
      )
        return err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            "Cancel the current scheduler before confirming a new execution.",
          ),
        );
      const invocationId = `execute-${command.id}`;
      const driver = this.executionScheduler(root, configuration, command.id);
      root.executionOwnership = {
        invocationId,
        consentId: command.id,
        driver,
        profiles: () => configuration.profiles(),
      };
      const committed = await persist((current) => {
        const receipt = current.version === 2 ? current.scheduler?.consents[command.id] : undefined;
        if (
          !receipt ||
          receipt.conversationId !== provenance.conversationId ||
          receipt.state !== "preview"
        )
          return err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "No matching unconfirmed execution preview.",
            ),
          );
        const valid = validateExecutionConsent(current, receipt, worktree, snapshots);
        if (!valid.ok) return valid;
        receipt.state = "confirmed";
        receipt.confirmedAt = provenance.receivedAt;
        current.revision++;
        return ok({ doc: current, effects: [], outcome: { kind: "applied" } });
      });
      if (!committed.ok) {
        await driver.shutdown();
        delete root.executionOwnership;
        return committed;
      }
      const started = await driver.control({
        kind: "started",
        invocationId,
        baselineRevision: committed.value.doc.revision,
      });
      if (!started.ok) {
        await driver.shutdown();
        delete root.executionOwnership;
        return started;
      }
      return ok(
        `Execution ${invocationId} admitted under consent ${command.id}. Use /workflow status.`,
      );
    }
    const invocation =
      doc.version === 2
        ? doc.scheduler?.invocations.findLast((item) =>
            command.id
              ? item.id === command.id
              : item.id === root.executionOwnership?.invocationId ||
                item.id === root.schedulerOwnership?.invocationId,
          )
        : undefined;
    if (!invocation)
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_FOUND",
          "No matching scheduler invocation. Use /workflow status and its exact ID.",
        ),
      );
    const kind =
      command.kind === "pause" ? "paused" : command.kind === "resume" ? "resumed" : "cancelled";
    if (invocation.state === "cancelled" || invocation.state === "completed")
      return command.kind === "cancel"
        ? ok(status(doc))
        : err(new WorkflowError("WORKFLOW_CONFLICT", "Terminal invocations cannot resume."));
    if (invocation.kind === "plan") {
      const controlled = await this.applyPlanningSchedulerControl(root, {
        kind,
        invocationId: invocation.id,
      });
      return controlled.ok ? ok(`Planning ${invocation.id}: ${kind}.`) : controlled;
    }
    if (
      this.workflowMembers(root, doc).some(
        (member) => member !== root && member.executionOwnership?.invocationId === invocation.id,
      )
    )
      return err(
        new WorkflowError("WORKFLOW_CONFLICT", "Another conversation owns this execution."),
      );
    if (root.executionOwnership && root.executionOwnership.invocationId !== invocation.id)
      return err(
        new WorkflowError(
          "WORKFLOW_CONFLICT",
          "Control does not target the current execution owner.",
        ),
      );
    const receipt =
      doc.version === 2 && invocation.consentId
        ? doc.scheduler?.consents[invocation.consentId]
        : undefined;
    if (!receipt)
      return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Execution consent is unavailable."));
    if (kind === "resumed") {
      const valid = validateExecutionConsent(doc, receipt, worktree, snapshots);
      if (!valid.ok) return valid;
    }
    const driver =
      root.executionOwnership?.driver ?? this.executionScheduler(root, configuration, receipt.id);
    if (!root.executionOwnership) {
      const recovered = await driver.control({ kind: "restarted", invocationId: invocation.id });
      if (!recovered.ok) {
        await driver.shutdown();
        return recovered;
      }
      root.executionOwnership = {
        invocationId: invocation.id,
        consentId: receipt.id,
        driver,
        profiles: () => configuration.profiles(),
      };
    }
    if (kind === "cancelled" && root.executionOwnership) root.executionOwnership.cancelling = true;
    const controlled = await driver.control({ kind, invocationId: invocation.id });
    if (!controlled.ok) return controlled;
    if (kind === "cancelled") {
      await driver.shutdown();
      delete root.executionOwnership;
    }
    return ok(`Execution ${invocation.id}: ${kind}. Accepted changes were retained.`);
  }

  private async retireCompletedExecution(
    root: OpenExecution,
    doc: WorkflowDocument,
  ): Promise<void> {
    const owner = root.executionOwnership;
    const invocation =
      doc.version === 2
        ? doc.scheduler?.invocations.find((item) => item.id === owner?.invocationId)
        : undefined;
    if (
      owner &&
      invocation &&
      ["completed", "cancelled"].includes(invocation.state) &&
      ![...this.descendants(root)].some((run) => this.active(run) && run.operationId)
    ) {
      await owner.driver.shutdown();
      if (root.executionOwnership === owner) delete root.executionOwnership;
    }
  }

  private executionScheduler(
    root: OpenExecution,
    configuration: NonNullable<SessionExecutor["workflowScheduler"]>,
    consentId: string,
  ): PlanningSchedulerDriver {
    return new PlanningSchedulerDriver({
      profiles: () => (root.executionOwnership?.cancelling ? ok([]) : configuration.profiles()),
      snapshot: executionProfileSnapshot,
      runs: () =>
        [...this.entries.values()]
          .filter(
            (entry) =>
              entry.worktree?.path === root.worktree?.path && entry.scope.kind === root.scope.kind,
          )
          .flatMap((entry) =>
            [...this.descendants(entry)].map((run) => ({
              id: run.id,
              ...(run.operationId ? { operationId: run.operationId } : {}),
              active: this.active(run),
            })),
          ),
      commit: async (event, runs) => {
        if (!this.ownerCurrent(root, root, root.generation)) return err(new CancelledError());
        const opened = await this.openTaskWorkflow(root);
        if (!opened.ok) return opened;
        if (!opened.value)
          return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared."));
        let intents: SchedulerIntent[] = [];
        const committed = await mutateWorkflow(
          opened.value.location,
          opened.value.doc.origin,
          (doc) => {
            if (!doc) return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared."));
            const result = scheduleExecution(doc, runs, event, consentId);
            if (!result.ok) return result;
            intents = result.value.intents;
            return ok({ doc: result.value.doc, effects: [], outcome: { kind: "applied" } });
          },
          { requireVersion: 2 },
        );
        if (committed.ok) entrySummary(root, committed.value.doc);
        this.emit();
        return committed.ok ? ok({ doc: committed.value.doc, intents }) : committed;
      },
      launch: async (operationId, admission, profile) => {
        const opened = await this.openTaskWorkflow(root);
        if (!opened.ok) return opened;
        const task = opened.value?.doc.tasks[admission.taskId];
        if (!task || task.kind !== "implement")
          return err(
            new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Not an assigned implementation task."),
          );
        const role = admission.role;
        const instructions =
          role === "implementer"
            ? "Implement only the assigned scope. Preserve other changes. Run relevant checks, then radian-task submit. Do not declare your own QA pass."
            : role === "verifier"
              ? `Independently verify submitted revision ${admission.submittedRevision}. Do not edit product files. Record findings/verdict through radian-task for this exact revision; blocked is not pass.`
              : `Read-only analysis of locked defect ${admission.defectId}. Use radian-task analysis. Do not repair or reset locks; wait for the user's direct /repair command.`;
        return this.spawnChild(
          root,
          root,
          root.generation,
          profile.name,
          `${instructions}\nTask ${task.id}: ${task.title}\nScope: ${task.scope}\nFrozen plan inputs: ${admission.frozenInputs.join(", ") || "none"}\nDo not commit, install dependencies, change global settings or restart the host.`,
          {
            background: true,
            profile: { ...profile, effectiveProfile: admission.effectiveProfile },
            ...(role === "lead" ? { purpose: "analysis" as const } : {}),
            requestedBinding: {
              id: task.id,
              role,
              ...(admission.defectId && role !== "lead" ? { defectId: admission.defectId } : {}),
              ...(admission.attemptId && role === "verifier"
                ? { attemptId: admission.attemptId }
                : {}),
            },
            schedulerAdmission: { operationId, admission },
          },
        );
      },
      stop: async (operationId) => {
        const run = [...this.descendants(root)].find((item) => item.operationId === operationId);
        return run ? this.closeExecution(run) : ok(undefined);
      },
      report: (error) => {
        console.warn(`[radian:execution-scheduler] ${error.code}: ${error.message}`);
      },
      unexpected: (error) => {
        reportUnexpected(error, "execution scheduler");
      },
    });
  }

  async repair(
    sessionId: string,
    conversationId: string,
    command: RepairCommand,
    provenance: UserCommandProvenance,
  ): Promise<Result<string, ExpectedError>> {
    const selected = this.modelOwner(sessionId, conversationId);
    if (!selected.ok) return selected;
    const entry = selected.value;
    if (provenance.kind !== "user-command" || provenance.conversationId !== conversationId)
      return err(
        new WorkflowError(
          "WORKFLOW_NOT_AUTHORIZED",
          "Repair requires direct user-command provenance for this conversation.",
        ),
      );
    const executor = entry.executor!;
    if (!executor.sessionFile)
      return err(new WorkflowError("WORKFLOW_NOT_FOUND", "This conversation has no workflow."));
    const opened = await this.openTaskWorkflow(entry);
    if (!opened.ok) return opened;
    const event = {
      eventKey: `user:${conversationId}:${provenance.receivedAt}:${command.kind}:${"id" in command ? (command.id ?? "") : ""}:${crypto.randomUUID()}`,
      at: provenance.receivedAt,
    };
    let doc: WorkflowDocument;
    let notice: string | undefined;
    if (command.kind === "continue") {
      if (opened.value && opened.value.doc.workflowId !== command.workflowId)
        return err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            "This conversation already belongs to another workflow.",
          ),
        );
      let source = opened.value;
      const candidates = [...this.entries.values()]
        .filter(
          (candidate) =>
            candidate !== entry &&
            candidate.phase === "open" &&
            candidate.scope.kind === entry.scope.kind &&
            (entry.scope.kind === "chat" ||
              (candidate.scope.kind === "code" &&
                candidate.scope.worktreeId === entry.scope.worktreeId)),
        )
        .map((candidate) => ({
          sessionFile: candidate.executor?.sessionFile,
          conversationId: candidate.executor?.savedSessionId,
          cwd: candidate.worktree?.path ?? homedir(),
        }));
      for (const record of this.retired.values()) {
        if (
          (record.scope?.kind ?? "code") !== entry.scope.kind ||
          (entry.scope.kind === "code" && record.worktreeId !== entry.scope.worktreeId)
        )
          continue;
        candidates.push({
          sessionFile: record.sessionFile,
          conversationId: record.state.conversationId,
          cwd: record.cwd ?? homedir(),
        });
      }
      for (const candidate of candidates) {
        if (!candidate.sessionFile || !candidate.conversationId) continue;
        const found = await openWorkflow(candidate.sessionFile, {
          conversationId: candidate.conversationId,
          cwd: candidate.cwd,
        });
        if (!found.ok) return found;
        if (
          found.value &&
          found.value.doc.workflowId !== command.workflowId &&
          found.value.doc.members.some(
            (member) =>
              member.conversationId === conversationId || member.sessionFile === entry.fileKey,
          )
        )
          return err(
            new WorkflowError(
              "WORKFLOW_CONFLICT",
              "This conversation is already a member of another workflow.",
            ),
          );
        if (found.value?.doc.workflowId === command.workflowId) source = found.value;
      }
      if (!source)
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_FOUND",
            "Workflow not found among known conversations in this scope.",
          ),
        );
      const member = {
        conversationId,
        cwd: entry.worktree?.path ?? homedir(),
        sessionFile: entry.fileKey ?? executor.sessionFile,
      };
      const joined = await this.commitTaskWorkflow(entry, source, (current) =>
        addContinuationMember(current, { ...event, provenance, member }),
      );
      if (!joined.ok) return joined;
      const linked = await writeWorkflowLink(
        member.sessionFile,
        member,
        source.location,
        source.doc.origin,
      );
      if (!linked.ok) return linked;
      doc = joined.value.doc;
      notice = `Continued workflow ${doc.workflowId}.`;
    } else {
      if (!opened.value)
        return err(new WorkflowError("WORKFLOW_NOT_FOUND", "This conversation has no workflow."));
      const authorized = humanStatus(opened.value.doc, provenance);
      if (!authorized.ok) return authorized;
      const resolved = command.id ? resolveRepairId(authorized.value, command.id) : ok(undefined);
      if (!resolved.ok) return resolved;
      doc = authorized.value;
      if (command.kind !== "status") {
        const id = resolved.value!;
        const changed = await this.commitTaskWorkflow(entry, opened.value, (current) =>
          command.kind === "recheck"
            ? humanRecheck(current, {
                ...event,
                id,
                provenance,
                attemptId: crypto.randomUUID(),
              })
            : humanCancel(current, { ...event, id, provenance }),
        );
        if (!changed.ok) return changed;
        doc = changed.value.doc;
        if (command.kind === "cancel") {
          const isTask = !!doc.tasks[id];
          const taskIds = isTask ? [id] : (doc.defects[id]?.responsibleTasks ?? []);
          const retained: string[] = [];
          const stopWarnings: string[] = [];
          const runs = this.workflowMembers(entry, doc).flatMap((root) => [
            ...this.descendants(root),
          ]);
          for (const run of runs)
            if (
              this.active(run) &&
              run.binding?.workflowId === doc.workflowId &&
              (isTask ? run.binding.taskId === id : run.repairTarget?.defectId === id)
            ) {
              const otherTasks = [
                ...new Set(
                  [...this.descendants(run)]
                    .filter(
                      (child) =>
                        this.active(child) &&
                        child.binding &&
                        !taskIds.includes(child.binding.taskId),
                    )
                    .map((child) => child.binding!.taskId),
                ),
              ];
              if (otherTasks.length) {
                retained.push(
                  `Run ${run.id} not stopped: it owns active runs for tasks ${otherTasks.join(", ")}; its authority for ${run.binding.taskId} is revoked. Cancel those tasks or stop it from its owner.`,
                );
                continue;
              }
              const stopped = await this.closeExecution(run);
              if (!stopped.ok)
                stopWarnings.push(
                  `[${stopped.error.code}] run ${run.id} could not be stopped: ${stopped.error.message}`,
                );
            }
          notice = [
            "Cancel recorded. Accepted edits are not rolled back.",
            ...retained,
            ...stopWarnings,
          ].join("\n");
        } else {
          const taskId = doc.tasks[id] ? id : doc.defects[id]!.responsibleTasks[0]!;
          notice = `QA recheck of revision ${doc.tasks[taskId]!.artifactRevision} is required for ${taskId}.`;
        }
      }
      const status = renderRepairStatus(doc, resolved.value);
      if (!status.ok) return status;
      notice = `${notice ? notice + "\n" : ""}${status.value}`;
    }
    const text = (notice ?? renderWorkflowStatus(doc)).slice(0, 60000);
    const appended = await executor.appendNotice?.(text);
    return ok(
      appended && !appended.ok
        ? `${text}\n[${appended.error.code}] The host action was accepted, but displaying its transcript notice could not be confirmed.`
        : text,
    );
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
      if (query.command === "workflow") {
        const choices: CompletionItem[] = [
          ...["status", "pause", "resume", "cancel"].map((value) => ({
            kind: "argument" as const,
            value,
            description: `${value} the current workflow invocation`,
          })),
          {
            kind: "argument",
            value: "start all",
            description: "Preview the dependency-closed implementation scope (does not start work)",
          },
        ];
        const opened = await this.openTaskWorkflow(entry);
        if (!opened.ok) return opened;
        const doc = opened.value?.doc;
        if (doc)
          for (const task of Object.values(doc.tasks))
            if (task.kind === "implement" && task.status !== "cancelled")
              choices.push({
                kind: "argument",
                value: `start ${task.id}`,
                description: task.title,
              });
        if (doc?.version === 2 && doc.scheduler) {
          for (const invocation of doc.scheduler.invocations)
            for (const action of ["status", "pause", "resume", "cancel"])
              choices.push({
                kind: "argument",
                value: `${action} ${invocation.id}`,
                description: `${invocation.kind} ${invocation.state}`,
              });
          for (const receipt of Object.values(doc.scheduler.consents))
            if (receipt.state === "preview")
              choices.push({
                kind: "argument",
                value: `confirm ${receipt.id}`,
                description: "Explicitly approve the displayed execution scope",
              });
        }
        return ok(filterCompletions(choices, query.query));
      }
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
      repairCommand,
      workflowCommand,
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
      [...this.descendants(entry)].some(
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
    const workflow = parseWorkflowCommand(text);
    if (!workflow.ok) return workflow;
    if (workflow.value)
      return err(new CapabilityError("Use the host /workflow command. No model prompt was sent."));
    const current = this.entries.get(id);
    if (
      current &&
      [...this.entries.values()].some(
        (entry) =>
          entry.executionOwnership &&
          entry.scope.kind === current.scope.kind &&
          entry.worktree?.path === current.worktree?.path,
      )
    )
      return err(
        new SessionError(
          "SESSION_BUSY",
          "Scheduled execution owns this worktree. Use /workflow controls; cancel it before starting unrelated model work.",
        ),
      );
    const repair = parseRepairCommand(text);
    if (!repair.ok) return repair;
    if (repair.value)
      return err(new CapabilityError("Use the host /repair command. No model prompt was sent."));
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
      [...this.descendants(entry)].some(
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

    const task = this.replaceSession(previous, this.scopeEpoch(previous.scope), onAccepted).finally(
      () => {
        previous.replacing = false;
        this.replacements.delete(task);
        this.emit();
      },
    );
    this.replacements.add(task);

    return this.trackScoped(previous.scope, task);
  }

  /** All root lifecycles share the same host capabilities and factory policy. */
  private rootFactoryOptions(
    id: string,
    generation: string,
    scope: SessionScope,
    cwd: string,
  ): SessionContext {
    return {
      cwd,
      scope,
      ...(scope.kind === "code" ? { worktreeId: scope.worktreeId } : {}),
      role: "main",
      isUiActive: () => this.uiActive,
      spawnSubagent: (name, task, signal) => this.spawnSubagent(id, name, task, signal, generation),
      coordinateSubagents: (command, signal, purpose, target) =>
        this.coordinateSubagents(id, generation, command, signal, purpose, target),
      controlPlanningScheduler: (command) => this.controlPlanningScheduler(id, command),
      planningSchedulerOwnership: () => {
        const ownership = this.entries.get(id)?.schedulerOwnership;
        return ownership
          ? { invocationId: ownership.invocationId, state: ownership.state }
          : undefined;
      },
      coordinateTask: (command, callId, signal, profiles) =>
        this.coordinateTask(id, generation, undefined, command, callId, signal, profiles),
    };
  }

  private async replaceSession(
    previous: OpenExecution,
    epoch: number,
    onAccepted?: () => void,
  ): Promise<Result<void, ExpectedError>> {
    const cancelled = () =>
      this.shuttingDown || previous.phase !== "open" || !this.scopeCurrent(previous.scope, epoch);
    // Prepare a distinct SDK conversation before interrupting the old one. A
    // failed factory must not discard a working tab or its on-disk history.
    const allowed = await previous.executor?.beforeNewSession?.();
    if (allowed && !allowed.ok) {
      return allowed;
    }
    if (cancelled()) {
      return err(new CancelledError("Session replacement was cancelled by shutdown."));
    }

    const generation = crypto.randomUUID();
    const previousSessionFile = previous.executor?.sessionFile;
    const ready = capture(() =>
      this.factory({
        ...this.rootFactoryOptions(
          previous.id,
          generation,
          previous.scope,
          previous.worktree?.path ?? homedir(),
        ),
        startReason: "new",
        ...(previousSessionFile ? { previousSessionFile } : {}),
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
      } else if (cancelled()) {
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
          result = err(
            new AgentRunError(previous.recoveredState.error!, {
              cause: stopped.error,
            }),
          );
        } else if (cancelled()) {
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
      this.noteUnadoptedReplacement(previous, next);
      try {
        const cleanup = await next.close();
        if (!cleanup.ok) {
          this.strandIfRemoved(previous.scope, next);
          throw cleanup.error;
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Replacement and cleanup failed.");
      }

      throw error;
    }

    this.noteUnadoptedReplacement(previous, next);
    const cleanup = await next.close();
    if (!cleanup.ok) {
      this.strandIfRemoved(previous.scope, next);
    }

    return cleanup.ok
      ? result
      : err(
          new CleanupError("Replacement and cleanup failed.", [
            ...(!result.ok ? [result.error] : []),
            cleanup.error,
          ]),
        );
  }

  // The SDK may already have written a file for a conversation the removed scope never adopted.
  private noteUnadoptedReplacement(previous: OpenExecution, next: SessionExecutor): void {
    if (this.scopeFenced(previous.scope)) {
      this.noteExecutorCandidate(previous.scope, previous.id, "main", next, true);
    }
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

      if (entry.executionOwnership) await entry.executionOwnership.driver.shutdown();
      if (entry.schedulerOwnership) {
        await entry.schedulerOwnership.driver.shutdown();
        await Promise.all(
          [...this.descendants(entry)].flatMap((run) => (run.completion ? [run.completion] : [])),
        );
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
    // Only roots receive wake-up notifications. Nested owners observe their own children
    // through status/wait inside their single run, so a settled Lead is never restarted.
    if (
      child.owner !== owner ||
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

  /** Immediate children of a run-tree node. Roots always have a map; leaves have none. */
  private ownedBy(node: Execution): Map<string, Execution> {
    return node.role === "main" ? (node as OpenExecution).children : (node.children ??= new Map());
  }

  private active(node: Execution): boolean {
    return node.ready !== undefined || node.closing === true;
  }

  /** Pre-order walk of every descendant below a node, owners before their children. */
  private *descendants(node: Execution): Generator<Execution> {
    for (const child of (node.role === "main"
      ? (node as OpenExecution).children
      : node.children
    )?.values() ?? []) {
      yield child;
      yield* this.descendants(child);
    }
  }

  // An owner may coordinate only while its root conversation is current and, for nested
  // owners, while its own run has neither been cancelled nor released.
  private ownerCurrent(node: Execution, root: OpenExecution, generation: string): boolean {
    if (
      this.entries.get(root.id) !== root ||
      root.generation !== generation ||
      root.phase !== "open" ||
      root.replacing ||
      this.shuttingDown
    )
      return false;
    if (node === root) return true;
    for (let current: Execution | undefined = node; current && current !== root;) {
      if (!current.ready || current.controller?.signal.aborted) return false;
      current = current.owner;
    }
    return node.root === root;
  }

  private async coordinateSubagents(
    ownerId: string,
    generation: string,
    command: SubagentCommand,
    signal?: AbortSignal,
    purpose?: "planning" | "analysis",
    target?: AgentProfile,
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
    return this.coordinate(owner, owner, generation, command, signal, purpose, target);
  }

  private async coordinate(
    node: Execution,
    root: OpenExecution,
    generation: string,
    command: SubagentCommand,
    signal?: AbortSignal,
    purpose?: "planning" | "analysis",
    target?: AgentProfile,
  ): Promise<Result<unknown, ExpectedError>> {
    if (signal?.aborted) return err(new CancelledError());
    if (!this.ownerCurrent(node, root, generation))
      return err(new CancelledError("This owner can no longer coordinate subagents."));
    if (command.action === "list")
      return err(new CapabilityError("Profile discovery belongs to the session resource loader."));
    if (node.binding && ["spawn", "steer", "reply"].includes(command.action)) {
      const workflow = await this.openTaskWorkflow(root);
      if (!workflow.ok) return workflow;
      if (!workflow.value)
        return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Bound workflow is unavailable."));
      const allowed = authorizeTaskBinding(workflow.value.doc, node.binding, node.name);
      if (!allowed.ok) return allowed;
    }
    const owned = this.ownedBy(node);
    const schedulerOwnsPlanning = root.schedulerOwnership !== undefined;
    if (command.action === "spawn") {
      if (node === root && schedulerOwnsPlanning && purpose === "planning")
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            root.schedulerOwnership?.state !== "active"
              ? "Scheduler cleanup is still pending; retry cancel before manually spawning branch leads."
              : "Scheduler mode owns branch lead admission; declare and observe instead.",
          ),
        );
      if (target && target.name !== command.agent)
        return err(new InputError("The resolved agent profile does not match the request."));
      const background = command.async !== false;
      let childId: string | undefined;
      const result = await this.spawnChild(node, root, generation, command.agent, command.task, {
        ...(signal ? { signal } : {}),
        background,
        requireSynchronous: command.async === false,
        onCreated: (id) => {
          childId = id;
        },
        ...(purpose ? { purpose } : {}),
        ...(target ? { profile: target } : {}),
        ...(command.binding ? { requestedBinding: command.binding } : {}),
      });
      return result.ok ? ok(this.childStatus(owned.get(childId!)!, true, purpose)) : result;
    }
    const children = command.id
      ? [owned.get(command.id)]
      : [...owned.values()].filter((child) => !purpose || child.purpose === purpose);
    if (children.some((child) => !child))
      return err(new InputError("This run does not belong to the current owner."));
    const runs = children as Execution[];
    if (purpose && runs.some((child) => child.purpose !== purpose))
      return err(new InputError("This run does not belong to the planning request."));
    if (command.action === "status")
      return ok(runs.map((child) => this.childStatus(child, command.id !== undefined, purpose)));
    if (command.action === "wait") {
      const settled = () =>
        runs.every((child) => !this.active(child)) ||
        (purpose ? runs : [...owned.values()]).some((child) => child.channel?.questions.length);
      const current = () => this.ownerCurrent(node, root, generation);
      if (!settled()) {
        const response = Promise.withResolvers<void>();
        const cancel = () => response.resolve();
        const unsubscribe = this.subscribe(() => {
          if (settled() || !current()) response.resolve();
        });
        signal?.addEventListener("abort", cancel, { once: true });
        node.controller?.signal.addEventListener("abort", cancel, {
          once: true,
        });
        try {
          await response.promise;
        } finally {
          unsubscribe();
          signal?.removeEventListener("abort", cancel);
          node.controller?.signal.removeEventListener("abort", cancel);
        }
        if (signal?.aborted || !current()) return err(new CancelledError());
      }
      if (runs.every((child) => !this.active(child)))
        await Promise.all(runs.flatMap((child) => (child.completion ? [child.completion] : [])));
      if (signal?.aborted || !current()) return err(new CancelledError());
      const attention = purpose
        ? []
        : [...owned.values()].filter(
            (child) => child.channel?.questions.length && !runs.includes(child),
          );
      return ok(
        [...runs, ...attention].map((child) =>
          this.childStatus(child, command.id !== undefined, purpose),
        ),
      );
    }
    const child = runs[0]!;
    if (
      (command.action === "reply" || command.action === "steer") &&
      child.binding?.role === "implementer"
    ) {
      const workflow = await this.openTaskWorkflow(root);
      if (!workflow.ok) return workflow;
      if (!workflow.value)
        return err(new WorkflowError("WORKFLOW_NOT_AUTHORIZED", "Bound workflow is unavailable."));
      const authorized = authorizeTaskBinding(workflow.value.doc, child.binding, child.name);
      if (!authorized.ok) return authorized;
      const allowed = guardImplementation(workflow.value.doc, child.binding.taskId);
      if (!allowed.ok) return allowed;
    }
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

  private childStatus(child: Execution, detail = true, purpose?: "planning" | "analysis"): unknown {
    const state = child.executor?.state;
    child.observedNoticeVersion = child.noticeVersion ?? 0;
    if (!this.active(child)) child.terminalObserved = true;
    const live = [...this.descendants(child)].filter((descendant) =>
      this.active(descendant),
    ).length;
    return {
      id: child.id,
      agent: child.name,
      ...((child.executor?.enforcement ?? child.enforcement)
        ? { enforcement: child.executor?.enforcement ?? child.enforcement }
        : {}),
      ...((child.executor?.effectiveProfile ?? child.effectiveProfile)
        ? { effectiveProfile: child.executor?.effectiveProfile ?? child.effectiveProfile }
        : {}),
      ...(child.binding ? { binding: child.binding } : {}),
      ...(child.repairTarget ? { repairTarget: child.repairTarget } : {}),
      task: (child.task ?? child.request?.text)?.slice(0, detail ? 16_384 : 400),
      status: this.active(child)
        ? child.channel?.questions.length
          ? "waiting"
          : "working"
        : child.failure
          ? "failure"
          : (child.finishedStatus ?? "stopped"),
      currentTools: state?.activeTools ?? [],
      progress: (child.channel?.progress ?? child.progress ?? [])
        .slice(detail ? -16 : -1)
        .map((update) => ({
          ...update,
          message: update.message.slice(0, detail ? 2048 : 512),
        })),
      questions: (child.channel?.questions ?? []).map((question) => ({
        ...question,
        message: question.message.slice(0, detail ? 16_384 : 512),
      })),
      output: (child.unfinished || this.active(child)
        ? ""
        : (state?.finalOutput ?? child.finalOutput ?? "")
      ).slice(0, 16_384),
      recentOutput: (state?.output ?? child.output ?? "").slice(detail ? -16_384 : -512),
      ...(child.failure ? { error: child.failure } : {}),
      ...((state?.runTiming ?? child.runTiming)
        ? { runTiming: state?.runTiming ?? child.runTiming }
        : {}),
      ...(child.fileKey ? { sessionFile: child.fileKey } : {}),
      ...(child.delegating ? { delegating: true, activeDescendants: live } : {}),
      ...(purpose === "planning" &&
      child.purpose === "planning" &&
      child.settled &&
      !child.failure &&
      child.planningProposal
        ? { proposal: structuredClone(child.planningProposal) }
        : {}),
    };
  }

  // Root-session spawning for host integrations; the root always owns the new run.
  private async spawnSubagent(
    ownerId: string,
    name: string,
    task: string,
    signal?: AbortSignal,
    generation?: string,
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

    return this.spawnChild(owner, owner, owner.generation, name, task, signal ? { signal } : {});
  }

  /**
   * Reserves a run-tree slot synchronously, then creates and runs one child. Limits are
   * root-wide and checked in the same tick as the reservation so concurrent spawns cannot
   * overshoot. Overflow is rejected immediately; nothing is queued.
   */
  private async spawnChild(
    owner: Execution,
    root: OpenExecution,
    generation: string,
    name: string,
    task: string,
    options: Parameters<SessionRegistry["launchChild"]>[5],
  ): Promise<Result<string, ExpectedError>> {
    const token = Symbol();
    this.startingRuns.set(token, root);
    try {
      return await this.launchChild(owner, root, generation, name, task, options);
    } finally {
      this.startingRuns.delete(token);
    }
  }

  private async launchChild(
    owner: Execution,
    root: OpenExecution,
    generation: string,
    name: string,
    task: string,
    options: {
      readonly signal?: AbortSignal;
      readonly background?: boolean;
      readonly onCreated?: (id: string) => void;
      readonly purpose?: "planning" | "analysis";
      readonly profile?: AgentProfile;
      readonly requestedBinding?: TaskSpawnBinding;
      readonly requireSynchronous?: boolean;
      readonly schedulerAdmission?: { operationId: string; admission: SchedulerAdmission };
    },
  ): Promise<Result<string, ExpectedError>> {
    const { signal, background = false, onCreated, profile } = options;
    if (profile) {
      const admitted = profileAdmission(profile);
      if (!admitted.ok) return admitted;
    }
    const child: Execution = {
      id: crypto.randomUUID(),
      ...(options.schedulerAdmission
        ? { operationId: options.schedulerAdmission.operationId }
        : {}),
      name,
      task,
      role: "subagent",
      ...(profile ? { profile } : {}),
      owner,
      root,
      ready: undefined,
      controller: new AbortController(),
      ...(root.worktree ? { worktree: root.worktree } : {}),
      managed: true,
      request: summarizeRequest(task, 0),
    };
    try {
      let purpose = owner.purpose ?? options.requestedBinding?.purpose ?? options.purpose;
      if (
        !options.schedulerAdmission &&
        !purpose &&
        [...this.entries.values()].some(
          (entry) =>
            entry.executionOwnership &&
            entry.worktree?.path === root.worktree?.path &&
            entry.scope.kind === root.scope.kind,
        )
      )
        return err(
          new WorkflowError(
            "WORKFLOW_NOT_AUTHORIZED",
            "Execution scheduler owns write-capable admission in this worktree.",
          ),
        );
      if (signal?.aborted) return err(new CancelledError());
      if (!this.ownerCurrent(owner, root, generation))
        return err(new CancelledError("This owner can no longer start subagents."));
      const depth = (owner === root ? 0 : (owner.depth ?? 1)) + 1;
      if (depth > delegationLimits.maxDepth)
        return err(
          new DelegationError(
            "DELEGATION_DEPTH_EXCEEDED",
            `Delegation is limited to ${delegationLimits.maxDepth} levels below the root. Do this work directly or return it to your owner.`,
          ),
        );
      // Durable admission precedes capacity reservation. An authorized attempt is reusable
      // when capacity is temporarily full; it is not a second repair attempt.
      let binding: WorkflowBinding | undefined;
      let repairTarget: RepairTarget | undefined;
      const workflow = root.executor?.sessionFile ? await this.openTaskWorkflow(root) : ok(null);
      if (!workflow.ok) return workflow;
      if (options.requestedBinding) {
        if (!workflow.value)
          return err(new WorkflowError("WORKFLOW_NOT_FOUND", "This conversation has no workflow."));
        const resolved = resolveTaskBinding(
          workflow.value.doc,
          { ...options.requestedBinding, ...(purpose ? { purpose } : {}) },
          name,
          owner === root
            ? { kind: "root" }
            : owner.binding
              ? { kind: "bound", binding: owner.binding, profile: owner.name }
              : { kind: "unbound" },
        );
        if (!resolved.ok) return resolved;
        binding = resolved.value;
        if (
          binding.role === "lead" ||
          binding.role === "verifier" ||
          (options.schedulerAdmission && binding.role === "implementer")
        )
          Object.assign(child, {
            planInputs: options.schedulerAdmission
              ? {
                  boundRevision: options.schedulerAdmission.admission.boundRevision!,
                  dependencies: options.schedulerAdmission.admission.frozenInputs.map((ref) => {
                    const separator = ref.lastIndexOf("@");
                    return {
                      artifactId: ref.slice(0, separator),
                      revision: Number(ref.slice(separator + 1)),
                    };
                  }),
                  missing: [],
                }
              : capturePlanInputs(workflow.value.doc, binding.taskId),
          });
        if (binding.role === "implementer") {
          const admitted = await this.admitTaskRepair(
            root,
            workflow.value,
            binding,
            options.requestedBinding,
            child,
          );
          if (!admitted.ok) return admitted;
          repairTarget = admitted.value;
        } else if (binding.role === "verifier" && options.requestedBinding.defectId) {
          const defect = workflow.value.doc.defects[options.requestedBinding.defectId];
          const attempt = defect?.attempts.find(
            (attempt) =>
              attempt.submittedTaskId === binding!.taskId &&
              (options.requestedBinding!.attemptId
                ? attempt.id === options.requestedBinding!.attemptId
                : attempt.status === "submitted"),
          );
          if (!defect?.responsibleTasks.includes(binding.taskId) || !attempt)
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Verifier target does not belong to this task's submitted attempt.",
              ),
            );
          repairTarget = Object.freeze({ defectId: defect.id, attemptId: attempt.id });
        } else if (options.requestedBinding.defectId || options.requestedBinding.attemptId) {
          return err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Repair targets require an implementer or verifier defect binding.",
            ),
          );
        }
      } else if (workflow.value && !purpose) {
        const allowed = guardUnboundTask(workflow.value.doc, task);
        if (!allowed.ok) return allowed;
      }
      if (binding?.purpose) purpose = binding.purpose;
      if (signal?.aborted || !this.ownerCurrent(owner, root, generation))
        return err(new CancelledError());
      if (options.requireSynchronous && profile?.delegation?.enabled)
        return err(
          new CapabilityError(
            "Delegating agents run asynchronously only. Spawn without async: false and wait.",
          ),
        );
      if (
        options.requireSynchronous &&
        [...this.ownedBy(owner).values()].some((child) => this.active(child))
      )
        return err(
          new CapabilityError(
            "Use asynchronous spawn while other owned runs are active so questions can be answered.",
          ),
        );
      // Reopen after asynchronous admission: assignments and locks may have changed.
      if (binding) {
        const current = await this.openTaskWorkflow(root);
        if (!current.ok) return current;
        if (!current.value)
          return err(new WorkflowError("WORKFLOW_NOT_FOUND", "Workflow disappeared."));
        const resolved = resolveTaskBinding(
          current.value.doc,
          { ...options.requestedBinding!, ...(purpose ? { purpose } : {}) },
          name,
          owner === root
            ? { kind: "root" }
            : owner.binding
              ? { kind: "bound", binding: owner.binding, profile: owner.name }
              : { kind: "unbound" },
        );
        if (!resolved.ok) return resolved;
        const authorized = authorizeTaskBinding(current.value.doc, binding, name);
        if (!authorized.ok) return authorized;
        binding = resolved.value;
        purpose = binding.purpose ?? purpose;
        if (repairTarget && binding.role === "implementer") {
          const attempt = current.value.doc.defects[repairTarget.defectId]?.attempts.find(
            (item) => item.id === repairTarget!.attemptId,
          );
          if (attempt?.status !== "authorized")
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Repair attempt no longer authorizes a launch.",
              ),
            );
          const allowed = guardImplementation(current.value.doc, binding.taskId);
          if (!allowed.ok) return allowed;
        }
      }
      if (signal?.aborted || !this.ownerCurrent(owner, root, generation))
        return err(new CancelledError());
      if (options.schedulerAdmission && binding) {
        const current = await this.openTaskWorkflow(root);
        if (!current.ok) return current;
        const doc = current.value?.doc;
        const facts =
          doc?.version === 2
            ? doc.scheduler?.admissions[options.schedulerAdmission.operationId]
            : undefined;
        const invocation =
          doc?.version === 2
            ? doc.scheduler?.invocations.find((item) => item.id === facts?.invocationId)
            : undefined;
        if (
          !facts ||
          facts.state !== "launching" ||
          facts.stopReason ||
          invocation?.state !== "active" ||
          facts.assignmentVersion !== binding.assignmentVersion ||
          (invocation.kind === "plan"
            ? facts.role !== "lead" || purpose !== "planning"
            : facts.role !== binding.role ||
              invocation.consentId !== root.executionOwnership?.consentId)
        )
          return err(
            new WorkflowError(
              "WORKFLOW_NOT_AUTHORIZED",
              "Scheduler admission no longer authorizes launch.",
            ),
          );
        if (invocation.kind === "execute") {
          const checked = this.checkExecutionConsent(root, doc!, facts.invocationId!);
          if (!checked.ok) return checked;
          if (facts.submittedRevision !== doc!.tasks[binding.taskId]!.artifactRevision)
            return err(
              new WorkflowError(
                "WORKFLOW_NOT_AUTHORIZED",
                "Scheduled revision changed before launch.",
              ),
            );
        }
        if (!this.ownerCurrent(owner, root, generation)) return err(new CancelledError());
      }
      // Scheduler and manual bindings share the same synchronous reservation boundary.
      if (
        binding &&
        (root.schedulerOwnership !== undefined || root.executionOwnership !== undefined) &&
        [...this.descendants(root)].some(
          (run) =>
            this.active(run) &&
            run.binding?.workflowId === binding!.workflowId &&
            run.binding.taskId === binding!.taskId &&
            run.binding.role === binding!.role &&
            run.binding.assignmentVersion === binding!.assignmentVersion,
        )
      )
        return err(
          new WorkflowError(
            "WORKFLOW_CONFLICT",
            "This task role already has an active run; wait for cleanup or retry cancel.",
          ),
        );
      // Recheck capacity in the same synchronous section as the actual reservation.
      if (
        [...this.descendants(root)].filter((node) => this.active(node)).length >=
        delegationLimits.activeDescendants
      )
        return err(
          new DelegationError(
            "DELEGATION_CAPACITY_EXCEEDED",
            `This conversation already has ${delegationLimits.activeDescendants} active subagents across its run tree. Wait for or stop a run first; nothing was queued.`,
          ),
        );
      if ([...this.descendants(root)].length >= delegationLimits.retainedRuns)
        return err(
          new DelegationError(
            "DELEGATION_RETENTION_EXCEEDED",
            "This conversation has reached its retained-run limit. Start a new conversation.",
          ),
        );
      const owned = this.ownedBy(owner);
      const delegating = profile?.delegation?.enabled === true;
      Object.assign(child, {
        ...(purpose ? { purpose } : {}),
        ...(binding ? { binding } : {}),
        ...(repairTarget ? { repairTarget } : {}),
        depth,
        ...(delegating ? { delegating: true, children: new Map<string, Execution>() } : {}),
      } satisfies Partial<Execution>);
      child.channel = new SubagentChannel((event) => {
        if (child.operationId && (event.type === "question" || event.type === "question-settled"))
          (root.executionOwnership?.driver ?? root.schedulerOwnership?.driver)?.observe({
            kind: event.type === "question" ? "question-opened" : "question-answered",
            operationId: child.operationId,
            questionId: event.type === "question" ? event.question.id : event.questionId,
          });
        if (event.type !== "question-settled" && owner === root)
          this.notifyChild(root, child, event);
        this.emit();
      });
      const ready = capture(() =>
        this.factory({
          cwd: root.worktree?.path ?? homedir(),
          scope: root.scope,
          ...(root.scope.kind === "code" ? { worktreeId: root.scope.worktreeId } : {}),
          role: "subagent",
          agent: name,
          ...(profile ? { profile } : {}),
          ...(purpose ? { purpose } : {}),
          ...(this.boundAuthority(child)
            ? {
                authorizeTool: (_toolName: string) =>
                  this.authorizeTaskWrite(child, root, generation),
              }
            : {}),
          ...(binding
            ? {
                binding,
                coordinateTask: (
                  command: TaskCommand,
                  callId: string,
                  taskSignal?: AbortSignal,
                  profiles?: string[],
                ) =>
                  this.coordinateTask(
                    root.id,
                    generation,
                    child,
                    command,
                    callId,
                    taskSignal,
                    profiles,
                  ),
              }
            : {}),
          contactSupervisor: (command, childSignal) => {
            if (
              !this.ownerCurrent(owner, root, generation) ||
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
          ...(delegating
            ? {
                // Children inherit read-only purpose; they cannot select a new purpose.
                coordinateSubagents: (command, childSignal, childPurpose, target) =>
                  childPurpose && childPurpose !== purpose
                    ? Promise.resolve(
                        err(new CapabilityError("Only the root may start purpose-specific runs.")),
                      )
                    : this.coordinate(
                        child,
                        root,
                        generation,
                        command,
                        childSignal,
                        purpose,
                        target,
                      ),
                spawnSubagent: (agent, childTask, childSignal) =>
                  this.spawnChild(child, root, generation, agent, childTask, {
                    ...(childSignal ? { signal: childSignal } : {}),
                    ...(purpose ? { purpose } : {}),
                  }),
              }
            : {
                spawnSubagent: async () =>
                  err(new CapabilityError("This agent profile does not enable delegation.")),
              }),
        }),
      );
      // Reservation: the slot is held from here until confirmed cleanup clears `ready`.
      child.ready = ready;
      if (
        owner === root &&
        root.childrenSettledAt !== undefined &&
        Date.now() >= root.childrenSettledAt + 10_000
      ) {
        root.hiddenChildren ??= new Set();
        for (const id of root.children.keys()) root.hiddenChildren.add(id);
      }
      owned.set(child.id, child);
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
        root,
        child,
        ready,
        task,
        child.controller!.signal,
        () => cancelTask,
        generation,
      ).finally(async () => {
        child.settled = true;
        if (child.operationId && !this.active(child))
          (root.executionOwnership?.driver ?? root.schedulerOwnership?.driver)?.observe({
            kind: "run-settled",
            operationId: child.operationId,
            runId: child.id,
            outcome: child.failure
              ? "failed"
              : child.finishedStatus === "complete"
                ? "completed"
                : "interrupted",
          });
        if (root.phase === "open" && !root.replacing) {
          const workflow = await this.openTaskWorkflow(root);
          if (!workflow.ok)
            console.warn(
              `[radian:workflow] ${workflow.error.code}: notice delivery deferred; inspect /repair status.`,
            );
          else if (workflow.value) {
            const routed = this.routeTaskWorkflow(root, workflow.value.doc);
            if (!routed.ok)
              console.warn(
                `[radian:workflow] ${routed.error.code}: notice delivery deferred; inspect /repair status.`,
              );
          }
        }
        this.emit();
      });
      child.completion = complete;
      if (background) {
        void complete
          .then((result) => {
            if (owner !== root) return;
            this.notifyChild(root, child, {
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
            if (owner === root)
              this.notifyChild(root, child, {
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
        if (signal?.aborted || !this.ownerCurrent(owner, root, generation)) {
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
    } finally {
      // Pre-launch failures retain the durable admission but never retain its live claim.
      if (!child.ready && !child.closing) this.releaseRepairClaim(child);
    }
  }

  private async completeChild(
    root: OpenExecution,
    child: Execution,
    ready: NonNullable<Execution["ready"]>,
    task: string,
    signal: AbortSignal,
    cancellation: () => Promise<Result<void, ExpectedError>> | undefined,
    generation: string,
  ): Promise<Result<string, ExpectedError>> {
    let result: Result<string, ExpectedError>;
    try {
      result = await this.runChild(root, child, ready, task, signal, generation);
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
    if (!result.ok && !(result.error instanceof CancelledError) && root.phase === "open") {
      child.failure = result.error.message;
      this.emit();
    }

    // A finished model turn does not prove subtree cleanup. Closing the child closes its
    // remaining descendants too; only confirmed cleanup reports the outcome.
    const cleanup = await (cancellation() ?? this.closeExecution(child));
    if (!cleanup.ok) {
      child.failure = cleanup.error.message;
      if (root.phase === "open") {
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
    root: OpenExecution,
    child: Execution,
    ready: NonNullable<Execution["ready"]>,
    task: string,
    signal: AbortSignal,
    generation: string,
  ): Promise<Result<string, ExpectedError>> {
    const created = await ready;
    if (!created.ok) {
      return created;
    }

    const executor = created.value;
    child.executor = executor;
    if (executor.enforcement) Object.assign(child, { enforcement: executor.enforcement });
    if (executor.effectiveProfile)
      Object.assign(child, { effectiveProfile: executor.effectiveProfile });

    const key = await capture(() => this.fileKey(executor));
    if (!key.ok) {
      return key;
    }

    const selected = this.requireOpen(root.id);
    if (!selected.ok) {
      return selected;
    }
    if (signal.aborted || !this.ownerCurrent(child.owner ?? root, root, generation)) {
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
      if (root.phase === "open") {
        this.emit();
      }
    });
    this.emit();

    const startedAt = Date.now();
    const started = performance.now();

    child.runTiming = { startedAt, elapsedMs: 0 };

    let run: Result<void, ExpectedError>;
    try {
      const [prompted, workflow] = await Promise.all([
        executor.prompt(task),
        this.openTaskWorkflow(root),
      ]);
      if (!workflow.ok)
        console.warn(
          `[radian:workflow] ${workflow.error.code}: notice delivery deferred; inspect /repair status.`,
        );
      else if (workflow.value) {
        const routed = this.routeTaskWorkflow(root, workflow.value.doc);
        if (!routed.ok)
          console.warn(
            `[radian:workflow] ${routed.error.code}: notice delivery deferred; inspect /repair status.`,
          );
      }
      run = prompted;
    } finally {
      child.runTiming = {
        startedAt,
        elapsedMs: Math.max(0, performance.now() - started),
      };
    }
    if (!run.ok) {
      return run;
    }
    if (signal.aborted) {
      return err(new CancelledError());
    }
    if (executor.state.status === "failure") {
      return err(new AgentRunError(executor.state.error ?? "Subagent failed."));
    }
    // Each owner answers for its immediate children; their subtrees are covered recursively.
    const live = [...(child.children?.values() ?? [])].filter((owned) => this.active(owned));
    if (live.length) {
      child.unfinished = true;
      return err(
        new DelegationError(
          "DELEGATION_UNFINISHED",
          `${child.name} finished while ${live.length} owned run(s) were still active. They were cancelled; the result is incomplete.`,
        ),
      );
    }

    return ok(executor.state.finalOutput ?? "");
  }

  private closeExecution(
    execution: Execution,
    reason: "quit" | "new" = "quit",
  ): Promise<Result<void, ExpectedError>> {
    if (execution.subtreeTask) {
      return execution.subtreeTask;
    }
    execution.closing = true;

    // Cancel the branch together. Each node's cleanup awaits only its own handle and its
    // descendants', never an owner, so recursive cancellation cannot await itself.
    const descendants = [...(execution.children?.values() ?? [])];
    const task = collectCleanup(
      [
        this.closeNode(execution, reason),
        ...descendants.map((child) => {
          child.suppressNotifications = true;
          return this.closeExecution(child, reason);
        }),
      ],
      `Could not finish closing ${execution.name}`,
    ).then((result): Result<void, ExpectedError> => {
      if (!result.ok) {
        delete execution.subtreeTask;
      } else {
        execution.closing = false;
        if (execution.root?.phase === "open")
          (
            execution.root.executionOwnership?.driver ?? execution.root.schedulerOwnership?.driver
          )?.observe({ kind: "capacity-freed" });
        this.releaseRepairClaim(execution);
        this.emit();
      }
      return result.ok || result.error.errors.length !== 1 ? result : err(result.error.errors[0]!);
    });
    execution.subtreeTask = task;
    void task.catch(() => {
      delete execution.subtreeTask;
    });

    return task;
  }

  private closeNode(
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
      // Factory failures and defects are reported by create/runChild; no handle exists, so
      // only the reservation is released here.
      const created = await ready.catch(() => undefined);
      if (!created?.ok) {
        execution.ready = undefined;
        execution.closedAt ??= Date.now();
        this.emit();
        return ok(undefined);
      }

      const scope = execution.role === "subagent" ? execution.root?.scope : undefined;
      // Creation cancelled by deletion may leave an SDK file that no record describes yet.
      const ownerScope = scope ?? this.entries.get(execution.id)?.scope;
      if (ownerScope && this.scopeFenced(ownerScope)) {
        this.noteExecutorCandidate(
          ownerScope,
          execution.id,
          execution.role,
          created.value,
          execution.managed ?? false,
        );
      }
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
        if (scope) {
          execution.failure = closed.error.message;
          this.retireExecution(execution, scope, tree, [], created.value, archived);
        }
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
        if (finalOutput !== undefined && !execution.unfinished)
          execution.finalOutput ??= finalOutput;
        execution.finishedStatus =
          created.value.state.status === "working" ? null : created.value.state.status;
        // Releases this node's root-wide reservation exactly once, after confirmed cleanup.
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
    if (entry && this.scopeFenced(entry.scope)) {
      return err(this.scopeRemoved());
    }

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
      const running = [...this.descendants(entry)].some((child) => this.active(child));
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
        new HistoryError("HISTORY_CORRUPT", parsed.error.message, {
          cause: parsed.error,
        }),
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

function settledOk(): Result<void, never> {
  return ok(undefined);
}
