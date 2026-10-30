import {
  createAgentSession,
  getAgentDir,
  initTheme,
  ModelRuntime,
  parseSkillBlock,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionError,
  type ExtensionAPI,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
  ModelsError,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ExecutionState, SessionExecutor, SessionFactory } from "./session-registry.ts";
import {
  AgentRunError,
  CancelledError,
  CapabilityError,
  capture,
  InputError,
  ProtocolError,
  knownError,
  ModelSelectionError,
  reportUnexpected,
  SessionError,
  systemCode,
  withCleanup,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { SessionTranscript } from "./transcript.ts";
import { runCompletionEntryType, type RunCompletion } from "./run-completion.ts";
import { PiSessionTelemetry } from "./pi-session-telemetry.ts";
import { CommandDiagnostics, sessionCommands } from "./session-commands.ts";
import { FastMode } from "./fast-mode.ts";
import { taskPlanningExtension } from "./task-planning.ts";
import type { UsageMonitor } from "../usage/monitor.ts";
import { loadPromptImages } from "./prompt-attachments.ts";
import { ManualCompaction } from "./manual-compaction.ts";
import { summarizeRequest, type RequestSummary } from "./request-summary.ts";
import type { SessionResult } from "./session-attention.ts";
import { imageNamesEntryType } from "./transcript-images.ts";
import {
  parseModelCommand,
  type ModelCatalog,
  type ModelEffort,
  type ModelIdentity,
} from "./model-selection.ts";
import { completionLimit, expandSkillInvocation, type CompletionResult } from "./completion.ts";
import { parseSessionControl } from "./session-controls.ts";
import { parseHistoryCommand } from "./history-command.ts";
import { parseDashboardCommand } from "./dashboard-command.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { parseAccountsCommand } from "../accounts/model.ts";
import { bindAccountSession } from "../accounts/session.ts";
import { sessionResourceLoader } from "./resource-loader.ts";
import { CHAT_SCOPE_ID } from "./session-scope.ts";
import { ExtensionUiBridge, type ExtensionUiResponse } from "./extension-ui.ts";
import { McpAuthPicker } from "./mcp-auth-picker.ts";
import { withComponentCommands } from "./extension-capabilities.ts";
import { leafExcludedTools, leafPolicy } from "./leaf-extension.ts";
import { commandDisplay, commandDisplayEntryType, type CommandDisplay } from "./command-display.ts";
import { childSkills, discoverAgentProfiles, roleInstructions } from "./agent-profiles.ts";
import { subagentTool, supervisorTool } from "./subagent-tools.ts";
import { subagentInstructions } from "./subagent-instructions.ts";
import {
  SubagentNotifications,
  subagentEventType,
  subagentNotificationKind,
  subagentNotificationText,
  type SubagentNotice,
} from "./subagent-notifications.ts";

type QueuedUserMessage = Extract<
  ReturnType<AgentSession["agent"]["peekQueuedMessages"]>[number],
  { role: "user" }
>;

export type PiSessionOptions = {
  agentDir?: string;
  sessionDir?: string;
  defaultPackagePaths?: readonly string[];
  modelRuntime?: ModelRuntime;
  model?: NonNullable<AgentSession["model"]>;
  streamFn?: AgentSession["agent"]["streamFunction"];
  settings?: Partial<ReturnType<SettingsManager["getSettings"]>>;
  usageMonitor?: UsageMonitor;
  accounts?: AccountManager;
  chatDefaults?: () => { provider: string; model: string; effort?: string } | undefined;
  imageLoader?: (paths: readonly string[]) => Promise<Result<ImageContent[], ExpectedError>>;
};

export function piSessionFactory(options: PiSessionOptions = {}): SessionFactory {
  // RPC/headless extensions still format text with Pi's theme helpers. Radian owns
  // the terminal, so initialize the built-in palette without a terminal or watcher.
  initTheme("system");
  let runtime: Promise<ModelRuntime> | undefined;

  return async (context) => {
    if (!(await stat(context.cwd)).isDirectory()) {
      throw new InputError("Session working directory is not a directory.");
    }

    const agentDir = options.agentDir ?? getAgentDir();
    const chat = context.scope?.kind === "chat";
    const worktreeId = chat ? CHAT_SCOPE_ID : (context.worktreeId ?? context.cwd);
    const workspace = options.accounts ? await options.accounts.workspace(worktreeId) : undefined;

    runtime ??= workspace
      ? Promise.resolve(workspace.runtime)
      : options.modelRuntime
        ? Promise.resolve(options.modelRuntime)
        : ModelRuntime.create({
            authPath: join(agentDir, "auth.json"),
            modelsPath: join(agentDir, "models.json"),
          });

    const modelRuntime = workspace?.runtime ?? (await runtime);
    const chatDefaults = chat ? options.chatDefaults?.() : undefined;
    const settingsManager = options.streamFn
      ? SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        })
      : chat
        ? chatSettingsManager(agentDir)
        : SettingsManager.create(context.cwd, agentDir);
    const fast = new FastMode();
    const compaction = new ManualCompaction();
    const mcpAuth = new McpAuthPicker();
    const profiles = () =>
      discoverAgentProfiles(agentDir, context.cwd, settingsManager.isProjectTrusted());
    const discovered = context.role === "subagent" && context.agent ? profiles() : undefined;
    if (discovered && !discovered.ok) throw discovered.error;
    const profile = discovered?.ok
      ? discovered.value.find((entry) => entry.name === context.agent)
      : undefined;
    let executor: PiSessionExecutor | undefined;
    if (context.agent && !profile)
      throw new InputError(
        `Unknown agent: ${context.agent}. Use radian-subagent list to discover profiles.`,
      );
    const resourceLoader: ResourceLoader = sessionResourceLoader({
      cwd: context.cwd,
      agentDir,
      settingsManager,
      ...(chat
        ? {
            agentsFilesOverride: (result) => ({
              agentsFiles: result.agentsFiles.filter((file) => {
                const global = resolve(agentDir);
                const path = resolve(file.path);
                return path === global || path.startsWith(global + sep);
              }),
            }),
          }
        : {}),
      noThemes: true,
      eventBus: mcpAuth.eventBus,
      ...(context.role === "subagent"
        ? {
            skillsOverride: (result) => {
              const filtered = childSkills(result.skills);
              if (!filtered.ok) throw filtered.error;
              return { ...result, skills: filtered.value };
            },
          }
        : {}),
      appendSystemPromptOverride: (base) => {
        const instructions = [...base, subagentInstructions[context.role]];
        if (context.role === "subagent") return instructions;
        const catalog = profiles();
        if (!catalog.ok)
          return [
            ...instructions,
            `Agent profile discovery failed: ${catalog.error.message}. Use radian-subagent list to inspect the error before delegating.`,
          ];
        return [
          ...instructions,
          `Available agent profiles for radian-subagent (fresh context, shared worktree):\n${catalog.value.map(({ name, description }) => `- ${name}: ${description}`).join("\n") || "(none configured)"}`,
        ];
      },
      extensionFactories: [
        fast.extension,
        compaction.extension,
        ...(context.role === "main"
          ? [
              taskPlanningExtension((invocation) => {
                if (!executor)
                  throw new SessionError(
                    "SESSION_BUSY",
                    "Session initialization is still in progress.",
                  );
                executor.recordPlanRequest(invocation);
              }),
            ]
          : []),
        ...(context.role === "subagent" ? [leafPolicy(profile?.tools)] : []),
        ...(profile
          ? [
              (pi: ExtensionAPI) => {
                pi.on("before_agent_start", (event) => {
                  const instructions = roleInstructions(profile, resourceLoader.getSkills().skills);
                  if (!instructions.ok) throw instructions.error;
                  event.systemPromptOptions.appendSystemPrompt += `\n\n${instructions.value}`;
                });
              },
            ]
          : []),
      ],
      ...(options.defaultPackagePaths
        ? { defaultPackagePaths: options.defaultPackagePaths }
        : options.streamFn
          ? { defaultPackagePaths: [] }
          : {}),
      ...(options.streamFn && !options.defaultPackagePaths
        ? { noSkills: true, noContextFiles: true, noPromptTemplates: true }
        : {}),
    });

    await resourceLoader.reload();
    // Resource discovery reloads settings; apply CHAT selection and host overrides afterwards.
    const applyHostSettings = () =>
      settingsManager.applyOverrides({
        ...(chatDefaults?.provider ? { defaultProvider: chatDefaults.provider } : {}),
        ...(chatDefaults?.model ? { defaultModel: chatDefaults.model } : {}),
        ...(chatDefaults?.effort
          ? { defaultThinkingLevel: chatDefaults.effort as ModelEffort }
          : {}),
        ...options.settings,
        cacheWarming: "off",
      });
    applyHostSettings();

    // Keep CHAT child execution files out of the user-conversation History index.
    const sessionDir =
      chat && context.role === "subagent" && options.sessionDir
        ? join(options.sessionDir, "subagents")
        : options.sessionDir;
    const sessionManager = context.sessionFile
      ? SessionManager.open(context.sessionFile, sessionDir, context.cwd)
      : sessionDir
        ? SessionManager.create(context.cwd, sessionDir)
        : undefined;
    const roleModel = profile?.model
      ? modelRuntime.getModel(
          profile.model.slice(0, profile.model.indexOf("/")),
          profile.model.slice(profile.model.indexOf("/") + 1),
        )
      : undefined;
    if (profile?.model && !roleModel)
      throw new ModelSelectionError(
        `Agent ${profile.name} requires unavailable model ${profile.model}.`,
      );
    const { session } = await createAgentSession({
      cwd: context.cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      ...(context.startReason
        ? {
            sessionStartEvent: {
              type: "session_start",
              reason: context.startReason,
              ...(context.previousSessionFile
                ? { previousSessionFile: context.previousSessionFile }
                : {}),
            } as const,
          }
        : {}),
      ...(sessionManager ? { sessionManager } : {}),
      ...((roleModel ?? options.model) ? { model: roleModel ?? options.model } : {}),
      ...(profile?.thinking ? { thinkingLevel: profile.thinking } : {}),
      // SDK 1.2 retains unmatched MCP tools for codemode unless an mcp__ selector exists.
      // The bare namespace prefix is not an MCP tool; it opts into strict matching.
      // leafPolicy remains authoritative for every direct and nested tool call.
      ...(profile?.tools ? { tools: [...profile.tools, "radian-supervisor", "mcp__"] } : {}),
      ...(context.role === "main"
        ? {
            customTools: [
              subagentTool(async (command, signal) => {
                if (command.action === "list" || command.action === "spawn") {
                  const available = profiles();
                  if (!available.ok) return available;
                  if (command.action === "list")
                    return ok(available.value.map(({ prompt: _prompt, ...entry }) => entry));
                  if (!available.value.some((entry) => entry.name === command.agent))
                    return err(
                      new InputError(
                        `Unknown agent ${command.agent}. Available: ${available.value.map((entry) => entry.name).join(", ") || "none"}.`,
                      ),
                    );
                }
                return (
                  context.coordinateSubagents?.(command, signal) ??
                  err(new CapabilityError("This session cannot coordinate subagents."))
                );
              }),
            ],
          }
        : {
            customTools: [
              supervisorTool(
                context.contactSupervisor
                  ? (command, signal) => context.contactSupervisor!(command, signal)
                  : undefined,
              ),
            ],
            excludeTools: leafExcludedTools,
          }),
    });
    let adopted = false;
    const releaseTransport =
      options.accounts && !options.streamFn
        ? bindAccountSession(options.accounts, worktreeId, session)
        : () => {};
    const accountChanged = (provider: string) => executor?.credentialsChanged(provider);

    workspace?.listeners.add(accountChanged);

    const releaseAccounts = () => {
      workspace?.listeners.delete(accountChanged);
      releaseTransport();
    };

    return withCleanup(
      async () => {
        await mkdir(session.sessionManager.getSessionDir(), { recursive: true });
        if (profile?.thinking && session.thinkingLevel !== profile.thinking)
          throw new InputError(
            `Agent ${profile.name}'s model does not support thinking level ${profile.thinking}.`,
          );
        if (options.streamFn) {
          session.agent.streamFunction = options.streamFn;
        }

        const diagnostics = new CommandDiagnostics();
        const unsupportedSessionAction = async (): Promise<never> => {
          throw new CapabilityError(
            "Pi session replacement is not hosted here. Use Radian's session controls instead.",
          );
        };
        const ui =
          context.role === "main"
            ? new ExtensionUiBridge(
                session.extensionRunner.getUIContext(),
                mcpAuth.eventBus,
                agentDir,
              )
            : undefined;

        await session.bindExtensions({
          ...(ui ? { uiContext: ui.context, mode: "rpc" as const } : {}),
          onError: diagnostics.report,
          commandContextActions: {
            waitForIdle: () => session.waitForIdle(),
            newSession: unsupportedSessionAction,
            fork: unsupportedSessionAction,
            switchSession: unsupportedSessionAction,
            navigateTree: unsupportedSessionAction,
            reload: async () => {
              if (!executor)
                throw new SessionError(
                  "SESSION_BUSY",
                  "Session initialization is still in progress.",
                );
              const result = await executor.reload(true);
              if (!result.ok) {
                ui?.context.notify(
                  "Extension reload did not finish. Earlier accepted changes were not rolled back.",
                  "warning",
                );
                throw result.error;
              }
            },
          },
        });
        if (profile) {
          const instructions = roleInstructions(profile, resourceLoader.getSkills().skills);
          if (!instructions.ok) throw instructions.error;
          if (profile.tools) {
            const registered = new Set(session.getAllTools().map((tool) => tool.name));
            const missing = profile.tools.filter(
              (name) => !name.includes("*") && !registered.has(name),
            );
            if (missing.length)
              throw new InputError(
                `Agent ${profile.name} requires unavailable tools: ${missing.join(", ")}.`,
              );
          }
        }
        executor = new PiSessionExecutor(
          session,
          workspace?.usage ?? options.usageMonitor,
          diagnostics,
          fast,
          options.imageLoader,
          compaction,
          () => {
            options.accounts?.invalidateModels(worktreeId);
            applyHostSettings();
          },
          releaseAccounts,
          options.accounts
            ? (signal, refresh) => {
                if (refresh) {
                  options.accounts!.invalidateModels(worktreeId);
                }

                return options.accounts!.refreshModels(worktreeId, signal);
              }
            : undefined,
          ui,
          mcpAuth,
        );
        executor.setUiActive(context.isUiActive?.() ?? false);
        adopted = true;

        return executor;
      },
      async () => {
        if (!adopted) {
          await withCleanup(
            async () => {
              await session.abort();
              await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            },
            async () => {
              session.dispose();
              mcpAuth.dispose();
              releaseAccounts();
            },
          );
        }
      },
    );
  };
}

// SDK reload must reread user resources, but CHAT must never persist its model
// selection to Pi's global defaults or read project settings (including ~/.pi).
function chatSettingsManager(agentDir: string): SettingsManager {
  return SettingsManager.fromStorage(
    {
      withLock(scope, fn) {
        if (scope !== "global") {
          fn(undefined);
          return;
        }
        let current: string | undefined;
        try {
          current = readFileSync(join(agentDir, "settings.json"), "utf8");
        } catch (error) {
          if (systemCode(error) !== "ENOENT") throw error;
        }
        // Ignore the callback's write result: session-local setters remain in memory.
        fn(current);
      },
    },
    { projectTrusted: false },
  );
}

export class PiSessionExecutor implements SessionExecutor {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private status: ExecutionState["status"];
  private error: string | null = null;
  private partial = "";
  private readonly activeTools = new Map<string, string>();
  private readonly transcript: SessionTranscript;
  private readonly telemetry: PiSessionTelemetry;
  private readonly runs = new Set<Promise<Result<void, ExpectedError>>>();
  private readonly subagentNotifications = new SubagentNotifications();
  private subagentFlushScheduled = false;
  // Serialize only SDK admission, not model execution; messages live in Pi's queue.
  private admission: Promise<void> = Promise.resolve();
  private closeTask: Promise<Result<void, ExpectedError>> | undefined;
  private aborted = false;
  private closing = false;
  private disposed = false;
  private controlling = false;
  private resourceRevision = 0;
  private uiActive = false;
  private commandCatalog: ReturnType<typeof sessionCommands>;
  private modelSelectionSnapshot:
    | {
        current: ModelCatalog["current"];
        effort: ModelEffort;
        telemetry: NonNullable<ExecutionState["telemetry"]>;
      }
    | undefined;
  private compacting = false;
  private inputRevision = 0;
  private interrupting = false;
  private interruptTask: Promise<Result<void, ExpectedError>> | undefined;
  // Own undelivered messages only while interrupting; the SDK owns the live queue.
  private interruptedMessages: QueuedUserMessage[] = [];
  private readonly queuedCommandDisplays = new WeakMap<QueuedUserMessage, CommandDisplay>();
  private startingCommandDisplay: CommandDisplay | undefined;
  private commandToSave: QueuedUserMessage | undefined;
  private commandProjection: { leafId: string | null; ids: readonly string[] } | undefined;
  private started: { wall: number; monotonic: number } | undefined;
  private request: RequestSummary | undefined;
  private result: SessionResult | undefined;

  constructor(
    private readonly session: AgentSession,
    usage?: UsageMonitor,
    private readonly diagnostics = new CommandDiagnostics(),
    fast?: FastMode,
    private readonly imageLoader = loadPromptImages,
    private readonly compaction = new ManualCompaction(),
    private readonly reloadSettings: () => void = () => {},
    private readonly releaseAccounts: () => void = () => {},
    private readonly refreshAccountModels?: (
      signal?: AbortSignal,
      refresh?: boolean,
    ) => Promise<Result<void, ExpectedError>>,
    private readonly ui?: ExtensionUiBridge,
    private readonly mcpAuth?: McpAuthPicker,
  ) {
    this.status = this.finalStatus(false);
    // Packages may register aliases during session_start, after resource discovery.
    withComponentCommands(session.resourceLoader.getExtensions());
    this.commandCatalog = sessionCommands(session);
    this.transcript = new SessionTranscript(session.sessionManager.getBranch());
    const loadingErrors = session.resourceLoader.getExtensions().errors;
    if (loadingErrors.length) {
      console.warn("[radian:extensions] Extension loading failed", loadingErrors);
      this.transcript.notice(
        "Extension loading",
        `${loadingErrors.length} extension(s) could not load. Configured sources were retained without a bundled substitute. Inspect runtime.log for paths and errors.`,
        "error",
      );
    }
    const lastUser = session.messages.findLast((message) => message.role === "user");
    this.request = deliveredRequest(lastUser, lastUser && this.displayForMessage(lastUser));

    const sections = this.transcript.sections;
    const requestIndex = sections.findLastIndex(
      (section) =>
        section.kind === "user" || section.skillName !== undefined || section.request !== undefined,
    );
    const completion = sections
      .slice(Math.max(0, requestIndex))
      .findLast((section) => section.completion)?.completion;
    if (completion) {
      this.result = {
        id: crypto.randomUUID(),
        outcome: completion.outcome,
        completedAt: completion.completedAt,
        ...(this.request ? { request: this.request } : {}),
      };
    }

    this.telemetry = new PiSessionTelemetry(session, () => this.emit(), usage, fast);

    const stopUi = ui?.subscribe(() => this.emit());
    const stopSession = session.subscribe((event) => this.handleEvent(event));

    this.unsubscribe = () => {
      stopUi?.();
      stopSession();
    };
  }

  recordPlanRequest(invocation: string): void {
    // Persist the actual command before the custom turn. SDK custom-only turns do not
    // create a session file until an assistant message; this user entry also supplies
    // the SDK's firstMessage title without changing any user-specified session name.
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: invocation }],
      timestamp: Date.now(),
    };
    const manager = this.session.sessionManager;
    const entryId = manager.appendMessage(message);
    const display = commandDisplay(invocation, ["plan"])!;
    this.session.agent.state.messages = manager.buildSessionProjection().messages;
    this.transcript.recordPersistedUser(entryId, message, display);
    this.request = deliveredRequest(message, display);
    this.result = undefined;
    // The annotation follows its user entry so reverse History retains both at a prompt boundary.
    // Failure here cannot reject the already recorded request or its model turn.
    try {
      manager.appendCustomEntry(commandDisplayEntryType, { messageId: entryId, parts: display });
    } catch (error) {
      // The SDK advances its leaf before writing; later records must not depend on a failed annotation.
      manager.branch(entryId);
      const expected = knownError(error);
      const warning = expected
        ? `[${expected.code}] Planning was accepted, but saving its display metadata could not be confirmed.`
        : reportUnexpected(error, "planning command display persistence");
      this.transcript.notice("Command display persistence", warning, "error");
      this.ui?.context.notify(warning, "warning");
    }
    this.emit();
  }

  credentialsChanged(provider: string): void {
    if (this.session.model?.provider !== provider) {
      return;
    }

    this.telemetry.invalidateAccount();
    this.emit();
  }

  commands() {
    return this.commandCatalog;
  }

  async argumentCompletions(
    command: string,
    prefix: string,
    signal?: AbortSignal,
  ): Promise<Result<CompletionResult, ExpectedError>> {
    if (signal?.aborted || this.closing || this.disposed) return err(new CancelledError());
    const revision = this.resourceRevision;
    const callback = this.session.extensionRunner
      .getRegisteredCommands()
      .find((entry) => entry.invocationName === command)?.getArgumentCompletions;
    const options = (await callback?.(prefix)) ?? [];
    if (signal?.aborted || this.closing || this.disposed || revision !== this.resourceRevision) {
      return err(new CancelledError("Argument completions became stale."));
    }
    if (options.some((item) => !item.value || item.value.length > 4096)) {
      return err(new ProtocolError("Extension returned an invalid argument completion value."));
    }
    return ok({
      items: options.slice(0, completionLimit).map((item) => ({
        kind: "argument" as const,
        value: item.value,
        description: (item.description ?? item.label).slice(0, 1024),
      })),
      truncated: options.length > completionLimit,
    });
  }

  get extensionUi() {
    return this.ui?.state;
  }

  setUiActive(active: boolean): void {
    this.uiActive = active;
    this.ui?.setActive(active && !this.interrupting && !this.closing);
  }

  answerExtensionUi(response: ExtensionUiResponse): Result<void, ExpectedError> {
    return this.ui
      ? this.ui.answer(response)
      : err(new CapabilityError("This session does not host extension dialogs."));
  }

  imageData(id: string) {
    return this.transcript.imageData(id);
  }

  async models(
    signal?: AbortSignal,
    refresh = false,
  ): Promise<Result<ModelCatalog, ExpectedError>> {
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (this.closing || this.disposed) {
      return err(new SessionError("SESSION_NOT_OPEN", "Session is closing."));
    }

    const refreshed = await this.refreshAccountModels?.(signal, refresh);
    if (refreshed && !refreshed.ok) {
      return refreshed;
    }

    const loaded = await modelOperation(() =>
      this.session.modelRuntime.getAvailable(undefined, signal ? { signal } : {}),
    );
    if (!loaded.ok) {
      return loaded;
    }
    if (signal?.aborted) {
      return err(new CancelledError());
    }
    if (this.closing || this.disposed) {
      return err(new SessionError("SESSION_NOT_OPEN", "Session closed while loading models."));
    }

    const model = this.session.model;
    const current = this.modelSelectionSnapshot
      ? this.modelSelectionSnapshot.current
      : model
        ? { provider: model.provider, id: model.id }
        : null;
    const effort = this.modelSelectionSnapshot?.effort ?? this.session.thinkingLevel;

    return ok({
      conversationId: this.savedSessionId,
      current,
      effort,
      models: loaded.value.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        images: model.input.includes("image"),
        efforts: getSupportedThinkingLevels(model),
        effort: clampThinkingLevel(model, effort),
      })),
    });
  }

  selectModel(
    identity: ModelIdentity,
    effort?: ModelEffort,
  ): Promise<Result<string | null, ExpectedError>> {
    if (this.closing || this.disposed) {
      return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    }
    if (this.busy) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for this session's current work to finish before switching models. No work was interrupted.",
          ),
        ),
      );
    }

    const current = this.session.model;
    this.modelSelectionSnapshot = {
      current: current ? { provider: current.provider, id: current.id } : null,
      effort: this.session.thinkingLevel,
      telemetry: this.telemetry.read(),
    };
    this.controlling = true;

    const task = (async (): Promise<Result<string | null, ExpectedError>> => {
      const available = await this.models();
      if (!available.ok) {
        return available;
      }

      const allowed = available.value.models.some(
        (model) => model.provider === identity.provider && model.id === identity.id,
      );
      const model = allowed
        ? this.session.modelRuntime.getModel(identity.provider, identity.id)
        : undefined;
      if (!model) {
        return err(
          new ModelSelectionError(
            "This model is no longer available with the current provider credentials. Refresh the list and choose another model.",
          ),
        );
      }
      if (effort !== undefined && !getSupportedThinkingLevels(model).includes(effort)) {
        return err(
          new InputError(
            "This model does not support the selected effort. Refresh the list before applying. No settings were changed.",
          ),
        );
      }
      if (this.closing || this.disposed) {
        return err(
          new SessionError("SESSION_NOT_OPEN", "Session closed before the model could be changed."),
        );
      }

      let warning: string | null = null;
      const persistenceWarning = (code: string) =>
        `[${code}] ${effort === undefined ? "Model" : "Model and effort"} applied, but saving the selection could not be confirmed. Reconnect before retrying.`;
      const changed = await modelOperation(async () => {
        const current = this.session.model;
        const capabilitiesChanged =
          current &&
          getSupportedThinkingLevels(current).join() !== getSupportedThinkingLevels(model).join();
        if (!modelsAreEqual(current, model) || capabilitiesChanged) {
          await this.session.setModel(model, { persist: false });
        }
      });
      if (!changed.ok) {
        // The SDK applies live values before saving. Preserve accepted values and still finish the pair.
        if (this.session.model !== model || changed.error.code !== "STORAGE_FAILED") {
          return changed;
        }

        warning = persistenceWarning(changed.error.code);
      }
      if (!modelsAreEqual(this.session.model, model)) {
        return err(
          new AgentRunError(
            "An extension changed the selected model while applying settings. Reopen /model to inspect the current model and effort.",
          ),
        );
      }
      if (effort !== undefined) {
        const thinking = await modelOperation(async () => {
          this.session.setThinkingLevel(effort, { persist: false });
        });
        if (!thinking.ok) {
          if (this.session.thinkingLevel !== effort || thinking.error.code !== "STORAGE_FAILED") {
            return thinking;
          }

          warning = persistenceWarning(thinking.error.code);
        }
        if (this.session.thinkingLevel !== effort) {
          return err(
            new AgentRunError(
              "The selected effort changed while applying settings. Reopen /model to inspect the current model and effort.",
            ),
          );
        }
      }

      this.telemetry.refreshUsage();

      return ok(warning);
    })().finally(() => {
      this.controlling = false;
      this.modelSelectionSnapshot = undefined;
      this.runs.delete(tracked);
      this.emit();
    });
    const tracked = task.then((result) => (result.ok ? ok(undefined) : result));

    this.runs.add(tracked);
    // Cleanup waits for this operation too, without converting unexpected exceptions into input errors.
    void tracked.catch(() => {});

    return task;
  }

  get busy(): boolean {
    return (
      this.controlling ||
      this.interrupting ||
      !!this.interruptTask ||
      this.interruptedMessages.length > 0 ||
      this.runs.size > 0 ||
      !this.session.isIdle ||
      this.session.pendingMessageCount > 0
    );
  }

  get acceptsImages(): boolean {
    return this.session.model?.input.includes("image") ?? false;
  }

  get savedSessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get state(): ExecutionState {
    const messages = this.session.messages.slice(-12).flatMap((message) => {
      if (message.role === "user") {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");

        const display = this.displayForMessage(message);

        return [`You: ${display ? display.map((part) => part.text).join("\n") : text}`];
      }
      if (message.role === "assistant") {
        return [
          `Agent: ${message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")}`,
        ];
      }
      if (message.role === "toolResult") {
        return [
          `${message.toolName}: ${message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")}`,
        ];
      }

      return [];
    });
    if (this.partial) {
      messages.push(`Agent (streaming): ${this.partial}`);
    }

    messages.push(...this.activeTools.values());

    const finalOutput = this.finalResponse();
    return {
      conversationId: this.savedSessionId,
      resourceRevision: this.resourceRevision,
      status: this.status,
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      output: messages.join("\n\n").slice(-12000),
      activeTools: [...this.activeTools.values()].slice(0, 32).map((tool) => tool.slice(0, 512)),
      error: this.error,
      ...(this.request ? { request: this.request } : {}),
      ...(this.result ? { result: this.result } : {}),
      ...(this.status === "working" && this.compacting ? { activity: "compacting" as const } : {}),
      sections: this.transcript.sections,
      telemetry: this.modelSelectionSnapshot?.telemetry ?? this.telemetry.read(),
      ...(this.ui ? { externalSubagents: this.ui.subagents } : {}),
      pendingMessages: this.queuedMessages().map((message) => {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        const skill = parseSkillBlock(text);
        const display = this.queuedCommandDisplays.get(message);

        return summarizeRequest(
          display
            ? display.map((part) => part.text).join("\n")
            : skill
              ? skill.userMessage || `/skill:${skill.name}`
              : text,
          typeof message.content === "string"
            ? 0
            : message.content.filter((part) => part.type === "image").length,
        );
      }),
      ...(this.started
        ? {
            runTiming: {
              startedAt: this.started.wall,
              elapsedMs: Math.max(0, performance.now() - this.started.monotonic),
            },
          }
        : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  compact(instructions?: string, onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) {
      return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    }
    if (this.busy) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for this session's current work to finish before compacting. No work was interrupted.",
          ),
        ),
      );
    }

    this.controlling = true;

    const before = { status: this.status, error: this.error };
    let accepted = false;
    const task = this.compaction
      .run(this.session, instructions, () => {
        accepted = true;
        this.status = "working";
        this.error = null;
        this.emit();
        onAccepted?.();
      })
      .then((result): Result<void, ExpectedError> => {
        if (result.ok) {
          this.transcript.notice("Context compacted", result.value.summary);
        } else if (accepted) {
          this.transcript.notice(
            result.error instanceof CancelledError ? "Compaction cancelled" : "Compaction failed",
            `[${result.error.code}] ${result.error.message}`,
            result.error instanceof CancelledError ? "cancelled" : "error",
          );
        }

        this.status = before.status;
        this.error = before.error;
        this.telemetry.refreshUsage();

        return result.ok ? ok(undefined) : result;
      })
      .catch((error: unknown) => {
        this.status = "failure";
        this.error = "Unexpected compaction failure. Inspect runtime.log.";
        if (accepted) {
          this.transcript.notice("Compaction failed", this.error, "error");
        }

        throw error;
      })
      .finally(() => {
        this.compacting = false;
        this.controlling = false;
        this.started = undefined;
        this.runs.delete(task);
        this.emit();
      });

    this.runs.add(task);

    return task;
  }

  reload(fromExtension = false): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) {
      return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    }
    if (
      this.busy &&
      (!fromExtension ||
        this.runs.size > 1 ||
        !this.session.isIdle ||
        this.controlling ||
        this.interrupting ||
        this.session.pendingMessageCount > 0)
    ) {
      return Promise.resolve(
        err(
          new SessionError(
            "SESSION_BUSY",
            "Wait for this session's current work before reloading resources. No work was interrupted.",
          ),
        ),
      );
    }

    const previousSettingsErrors = this.session.settingsManager.drainErrors();
    if (previousSettingsErrors.length) {
      console.warn("[radian:settings] Earlier settings errors", previousSettingsErrors);
    }

    this.controlling = true;
    this.ui?.reset();
    this.mcpAuth?.reset();

    const reported: ExtensionError[] = [];
    const stopReporting = this.diagnostics.observe((error) => reported.push(error));
    const task = (async (): Promise<Result<void, ExpectedError>> => {
      const reloaded = await withCleanup(
        () =>
          modelOperation(() => this.session.reload({ beforeSessionStart: this.reloadSettings })),
        async () => stopReporting(),
      );
      if (!reloaded.ok) {
        console.warn("[radian:reload] Resource reload failed", reloaded.error);

        return err(
          new AgentRunError(
            "Resource reload did not finish. Resources may have changed; the previous completion catalog was retained. Inspect runtime.log before retrying.",
            { cause: reloaded.error },
          ),
        );
      }

      const loader = this.session.resourceLoader;
      const diagnostics = [...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics];
      const errors = [
        ...loader.getExtensions().errors,
        ...reported,
        ...this.session.settingsManager.drainErrors(),
        ...diagnostics.filter((item) => item.type === "error"),
      ];
      const warnings = diagnostics.filter((item) => item.type !== "error");
      if (warnings.length) {
        console.warn("[radian:reload] Resource diagnostics", warnings);
      }
      if (errors.length) {
        console.warn("[radian:reload] Resource loading failed", errors);

        return err(
          new AgentRunError(
            "Some resources could not reload. Resources may have changed; the previous completion catalog was retained. Inspect runtime.log before retrying.",
            { cause: errors },
          ),
        );
      }

      const catalog = sessionCommands(this.session);
      this.telemetry.refreshUsage("manual");
      this.commandCatalog = catalog;
      this.resourceRevision++;

      return ok(undefined);
    })().finally(() => {
      this.controlling = false;
      this.runs.delete(task);
      this.emit();
    });

    this.runs.add(task);

    return task;
  }

  prompt(
    text: string,
    onAccepted?: () => void,
    imagePaths: readonly string[] = [],
  ): Promise<Result<void, ExpectedError>> {
    const skills = text.startsWith("$") ? this.session.resourceLoader.getSkills().skills : [];
    const expanded = expandSkillInvocation(
      text,
      skills.map((skill) => skill.name),
    );
    if (expanded !== text) {
      const name = expanded.slice(7).split(/\s/u, 1)[0];
      if (!skills.some((skill) => skill.name === name)) {
        return Promise.resolve(
          err(
            new InputError(
              "This skill is not loaded in the current session. Use /reload after adding skills; input was retained.",
            ),
          ),
        );
      }

      text = expanded;
    }

    const dashboard = parseDashboardCommand(text);
    if (!dashboard.ok) {
      return Promise.resolve(dashboard);
    }
    if (dashboard.value) {
      return Promise.resolve(
        err(
          new CapabilityError(
            "Use /dashboard in the Agent input to open usage statistics. No model prompt was sent.",
          ),
        ),
      );
    }

    const control = parseSessionControl(text);
    if (!control.ok) {
      return Promise.resolve(control);
    }
    if (control.value) {
      return Promise.resolve(
        err(
          new CapabilityError(
            "Use Radian's host session controls for this command. No model prompt was sent.",
          ),
        ),
      );
    }

    const accounts = parseAccountsCommand(text);
    if (!accounts.ok) {
      return Promise.resolve(accounts);
    }
    if (accounts.value) {
      return Promise.resolve(
        err(
          new CapabilityError(
            "Use /accounts in the Agent input to manage accounts. No model prompt was sent.",
          ),
        ),
      );
    }

    const model = parseModelCommand(text);
    if (!model.ok) {
      return Promise.resolve(model);
    }
    if (model.value) {
      return Promise.resolve(
        err(
          new CapabilityError(
            "Use /model in the Agent input to open the model picker. No model prompt was sent.",
          ),
        ),
      );
    }

    const history = parseHistoryCommand(text);
    if (!history.ok) {
      return Promise.resolve(history);
    }
    if (history.value) {
      return Promise.resolve(
        err(
          new CapabilityError(
            "Use /history in the Agent input to open saved session history. No model prompt was sent.",
          ),
        ),
      );
    }

    return this.promptInput(text, onAccepted, imagePaths);
  }

  private promptInput(
    text: string,
    onAccepted?: () => void,
    imagePaths: readonly string[] = [],
    replayImages?: ImageContent[],
    replayDisplay?: CommandDisplay,
  ): Promise<Result<void, ExpectedError>> {
    if (this.interrupting) {
      return Promise.resolve(
        err(new SessionError("SESSION_BUSY", "Interruption is in progress. Input was retained.")),
      );
    }
    if (this.controlling) {
      return Promise.resolve(
        err(
          new SessionError("SESSION_BUSY", "Session control is in progress. Input was retained."),
        ),
      );
    }
    if (this.closing || this.disposed) {
      return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    }

    const revisionAtSubmission = this.inputRevision;
    const admitted = Promise.withResolvers<void>();
    const previous = this.admission;

    this.admission = admitted.promise;

    const task = previous
      .then(async (): Promise<Result<void, ExpectedError>> => {
        if (this.closing || this.disposed) {
          return err(new SessionError("SESSION_NOT_OPEN", "Session is closing."));
        }
        if (revisionAtSubmission !== this.inputRevision) {
          return err(new CancelledError("Pending input was cancelled by interruption."));
        }
        if (this.session.isCompacting && !this.session.isStreaming) {
          return err(
            new SessionError("SESSION_BUSY", "Session is compacting; retry after it finishes."),
          );
        }

        // Preparation is part of admission: a later text request must not overtake
        // an earlier image request while its bytes are being read or normalized.
        const loaded = replayImages
          ? ok(replayImages)
          : imagePaths.length
            ? await this.imageLoader(imagePaths)
            : ok([]);
        if (!loaded.ok) {
          return loaded;
        }
        if (revisionAtSubmission !== this.inputRevision) {
          return err(new CancelledError("Pending input was cancelled by interruption."));
        }
        if (this.closing || this.disposed) {
          return err(
            new SessionError("SESSION_NOT_OPEN", "Session closed while preparing image input."),
          );
        }
        if (this.session.isCompacting && !this.session.isStreaming) {
          return err(
            new SessionError("SESSION_BUSY", "Session is compacting; retry after it finishes."),
          );
        }
        if ((imagePaths.length || replayImages?.length) && !this.acceptsImages) {
          return err(
            new CapabilityError(
              "The selected model no longer accepts image input. Input was retained.",
            ),
          );
        }

        const images = loaded.value;
        const bareMcpAuth = text.trimEnd() === "/mcp-auth";
        const name = bareMcpAuth
          ? "mcp-auth"
          : text.startsWith("/")
            ? text.slice(1).split(" ", 1)[0]!
            : "";
        if (name) withComponentCommands(this.session.resourceLoader.getExtensions());
        const registered = name ? this.session.extensionRunner.getCommand(name) : undefined;
        if (images.length && registered) {
          return err(
            new InputError(
              `/${name} does not accept image attachments. Send the images in an ordinary prompt instead.`,
            ),
          );
        }

        const names = this.transcript.rememberImages(images, imagePaths);
        if (names.length) {
          const saved = await capture(async () =>
            this.session.sessionManager.appendCustomEntry(imageNamesEntryType, names),
          );
          if (!saved.ok) {
            return saved;
          }
          if (revisionAtSubmission !== this.inputRevision || this.closing || this.disposed) {
            return err(new CancelledError("Input was cancelled while saving attachment metadata."));
          }
        }

        const display =
          replayDisplay ??
          (!registered && !replayImages
            ? commandDisplay(
                text,
                this.session.promptTemplates.map((template) => template.name),
              )
            : undefined);
        let command = registered ? this.diagnostics.begin(name) : undefined;
        if (registered?.name === "subagents-inspect-rpc") this.ui?.takeInspection();
        let handled = false;
        let accepted = false;
        const accept = () => {
          if (!accepted && !command?.failure) {
            accepted = true;
            onAccepted?.();
          }
        };
        // A dialog proves the command was accepted, but admission stays serialized
        // until its handler finishes. The client answers through a separate operation.
        const stopDialog = command ? this.ui?.onDialog(accept) : undefined;
        // Admission, commands and handled input are not model runs. Only SDK work
        // events may publish working, including work started by an extension.
        const result = await withCleanup(
          async (): Promise<Result<void, ExpectedError>> => {
            if (bareMcpAuth) {
              if (!registered || !this.ui || !this.mcpAuth) {
                return err(
                  new CapabilityError(
                    "MCP authentication requires a configured MCP adapter and an interactive main session.",
                  ),
                );
              }

              // Refresh through the adapter's own command: a deferred runtime can publish an
              // empty shutdown snapshot before its real catalog is initialized.
              const status = this.session.extensionRunner
                .getRegisteredCommands()
                .find(
                  (candidate) =>
                    candidate.name === "mcp-adapter" &&
                    candidate.sourceInfo.path === registered.sourceInfo.path,
                );
              if (status) {
                if (command) {
                  this.diagnostics.end(command);
                }

                command = this.diagnostics.begin(status.invocationName);

                const initialized = await capture(() =>
                  this.session.prompt(`/${status.invocationName} status`, {
                    streamingBehavior: "steer",
                  }),
                );
                if (!initialized.ok || command.failure) {
                  return initialized;
                }

                this.diagnostics.end(command);
                command = this.diagnostics.begin(name);
              }

              const selected = await this.mcpAuth.select(this.ui.context);
              if (!selected.ok) {
                return selected;
              }
              if (
                selected.value === undefined ||
                revisionAtSubmission !== this.inputRevision ||
                this.closing ||
                this.disposed
              ) {
                handled = true;
                admitted.resolve();
                accept();

                return ok(undefined);
              }

              text = `/mcp-auth ${selected.value}`;
            }

            return capture(() =>
              this.session.prompt(text, {
                streamingBehavior: "steer",
                ...(replayImages ? { expandPromptTemplates: false } : {}),
                ...(images.length ? { images: [...images] } : {}),
                preflightResult: (disposition) => {
                  handled = disposition === "handled";
                  if (display && disposition === "started") {
                    this.startingCommandDisplay = display;
                  } else if (display && disposition === "queued") {
                    const queued = this.queuedMessages().at(-1);
                    if (queued) this.queuedCommandDisplays.set(queued, display);
                  }
                  admitted.resolve();
                  accept();
                },
              }),
            );
          },
          async () => {
            stopDialog?.();
            if (command) {
              this.diagnostics.end(command);
            }
          },
        );
        if (command?.failure) {
          this.ui?.cancelDialogs();

          const error = new AgentRunError(
            `Command /${name} failed${accepted ? "." : `: ${command.failure.error}.`} It may have changed state; inspect before retrying.`,
            { cause: command.failure },
          );
          // Do not copy arbitrary extension error text (possibly containing credentials) into UI state.
          if (accepted) {
            this.ui?.context.notify(error.message, "error");
          }

          return err(error);
        }
        if (!result.ok) {
          if (!this.closing) {
            this.status = "failure";
            this.error = result.error.message;
          }

          return result;
        }
        if (registered?.name === "subagents-inspect-rpc") {
          const inspection = this.ui?.takeInspection();
          if (inspection && !inspection.ok) return inspection;
          if (inspection?.ok) {
            this.transcript.notice(
              "Subagent inspection",
              inspection.value.text,
              inspection.value.failed ? "error" : "complete",
            );
            this.emit();
          }
        }
        if (handled) {
          return ok(undefined);
        }
        if (this.aborted) {
          return err(new CancelledError());
        }
        if (this.state.status === "failure") {
          return err(new AgentRunError(this.error ?? "Agent failed."));
        }

        return ok(undefined);
      })
      .catch((error: unknown) => {
        this.status = "failure";
        this.error = "Unexpected agent execution failure. Inspect runtime.log.";
        throw error;
      })
      .finally(() => {
        admitted.resolve();
        this.runs.delete(task);
        this.emit();
      });
    this.runs.add(task);
    this.emit();

    return task;
  }

  private queuedMessages(): QueuedUserMessage[] {
    const agent = this.session.agent;
    const steering = agent.steeringMode;
    const followUp = agent.followUpMode;
    // SDK peek follows delivery mode and otherwise exposes only the first item.
    // This synchronous snapshot must include all messages and their image blocks,
    // without changing the user's actual delivery policy or persisted settings.
    try {
      agent.steeringMode = "all";
      agent.followUpMode = "all";

      return [
        ...this.interruptedMessages,
        ...agent
          .peekQueuedMessages()
          .filter((message): message is QueuedUserMessage => message.role === "user"),
      ];
    } finally {
      agent.steeringMode = steering;
      agent.followUpMode = followUp;
    }
  }

  interrupt(onAccepted?: () => void): Promise<Result<void, ExpectedError>> {
    if (this.closing || this.disposed) {
      return Promise.resolve(err(new SessionError("SESSION_NOT_OPEN", "Session is closing.")));
    }
    if (this.interruptTask) {
      onAccepted?.();

      return this.interruptTask;
    }

    this.interrupting = true;
    this.subagentNotifications.clear();
    this.inputRevision++;

    const admission = this.admission;
    const runs = [...this.runs];

    this.interruptedMessages = this.queuedMessages();
    this.session.clearQueue();
    this.session.abortBash();

    const abort = this.session.abort();
    const task = (async (): Promise<Result<void, ExpectedError>> => {
      onAccepted?.();

      const stopped = await capture(async () => {
        this.ui?.setActive(false);
        // Raw-input cancellation is used by package-owned foreground slash runs.
        this.ui?.interrupt();
        // Abort first: an extension command may itself be waiting for SDK idle.
        await admission;
        // Preflight already in flight can have queued input after the first clear.
        this.interruptedMessages = this.queuedMessages();
        this.session.clearQueue();
        await Promise.all([abort, this.session.abort()]);
        await Promise.all(runs);
      });
      if (!stopped.ok) {
        return stopped;
      }
      if (this.closing || this.disposed || !this.interruptedMessages.length) {
        return ok(undefined);
      }

      const messages = this.interruptedMessages;
      const text = messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
        )
        .join("\n");
      const displays = messages.map((message) => this.queuedCommandDisplays.get(message));
      const replayDisplay = displays.some(Boolean)
        ? messages.flatMap(
            (message, index) =>
              displays[index] ?? [
                {
                  text:
                    typeof message.content === "string"
                      ? message.content
                      : message.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("\n"),
                },
              ],
          )
        : undefined;
      const images = messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "image"),
      );
      const accepted = Promise.withResolvers<Result<void, ExpectedError>>();
      let admitted = false;

      this.interrupting = false;

      const run = this.promptInput(
        text,
        () => {
          admitted = true;
          this.interruptedMessages = [];
          this.emit();
          accepted.resolve(ok(undefined));
        },
        [],
        images,
        replayDisplay,
      );
      void run.then(
        (result) => {
          if (!admitted) {
            accepted.resolve(result);
          }
        },
        (error: unknown) => {
          if (!admitted) {
            accepted.reject(error);
          } else {
            reportUnexpected(error, "resumed agent execution");
          }
        },
      );

      return accepted.promise;
    })().finally(() => {
      this.interrupting = false;
      this.interruptTask = undefined;
      this.ui?.setActive(this.uiActive && !this.closing);
      this.emit();
    });

    this.interruptTask = task;
    this.emit();

    return task;
  }

  notifySubagent(event: SubagentNotice, current: () => boolean = () => true): void {
    if (this.closing || this.disposed || this.interrupting) return;
    this.subagentNotifications.add(event, current);
    this.scheduleSubagentNotifications();
  }

  private scheduleSubagentNotifications(): void {
    if (
      !this.subagentNotifications.size ||
      this.subagentFlushScheduled ||
      this.closing ||
      this.disposed ||
      this.status === "working" ||
      this.busy
    )
      return;
    this.subagentFlushScheduled = true;
    queueMicrotask(() => {
      this.subagentFlushScheduled = false;
      if (this.closing || this.disposed || this.status === "working" || this.busy) return;
      const events = this.subagentNotifications.take();
      if (!events.length) return;
      // Never enqueue a follow-up while streaming: the registry may observe/reply
      // before this run settles. Revalidate current state at this idle boundary.
      const task = capture(() =>
        this.session.sendCustomMessage(
          {
            customType: subagentEventType,
            content: subagentNotificationText(events),
            display: false,
            details: { kind: subagentNotificationKind, version: 1, events },
          },
          { triggerTurn: true },
        ),
      );
      this.runs.add(task);
      void task
        .then((result) => {
          if (!result.ok && !(result.error instanceof CancelledError)) {
            console.warn(`[radian:subagents] ${result.error.code}: ${result.error.message}`);
            this.ui?.context.notify(
              `[${result.error.code}] Child state was retained, but notifying its parent failed. Inspect subagent status before retrying.`,
              "warning",
            );
          }
        })
        .catch((error: unknown) => reportUnexpected(error, "subagent notification"))
        .finally(() => {
          this.runs.delete(task);
          this.emit();
        });
    });
  }

  async steer(message: string): Promise<Result<unknown, ExpectedError>> {
    if (this.closing || this.disposed)
      return err(new SessionError("SESSION_NOT_OPEN", "The child is closing."));
    const queued = await capture(() => this.session.steer(message));
    return queued.ok ? ok({ disposition: queued.value, compliance: "not-confirmed" }) : queued;
  }

  async beforeNewSession(): Promise<Result<void, ExpectedError>> {
    if (this.disposed) {
      return ok(undefined);
    }

    const result = await this.session.extensionRunner.emit({
      type: "session_before_switch",
      reason: "new",
    });

    return result?.cancel
      ? err(new CancelledError("Session replacement was cancelled by an extension."))
      : ok(undefined);
  }

  close(reason: "quit" | "new" = "quit"): Promise<Result<void, ExpectedError>> {
    if (this.disposed) {
      return Promise.resolve(ok(undefined));
    }
    if (this.closeTask) {
      return this.closeTask;
    }

    this.closing = true;
    this.subagentNotifications.clear();
    this.ui?.dispose();

    const task = capture(async () => {
      this.session.clearQueue();
      this.session.abortBash();
      // Commands may be waiting for this run to become idle; abort before waiting for their admission.
      await this.session.abort();
      await this.admission;
      await withCleanup(
        async () => {
          // Run failure/cancellation is not cleanup failure, but unexpected rejections still propagate.
          await Promise.all(this.runs);
          if (this.interruptTask) {
            await this.interruptTask;
          }

          await this.session.extensionRunner.emit({ type: "session_shutdown", reason });
        },
        async () => {
          this.telemetry.dispose();
          this.session.dispose();
          this.mcpAuth?.dispose();
          this.releaseAccounts();
          this.unsubscribe();
          this.listeners.clear();
          this.disposed = true;
        },
      );
    }).then((result) => {
      if (!result.ok) {
        this.closeTask = undefined;
      }

      return result;
    });
    this.closeTask = task;
    void task.catch(() => {
      this.closeTask = undefined;
    });

    return task;
  }

  private handleEvent(event: AgentSessionEvent): void {
    this.ui?.observeEvent(event);

    // Public message_end precedes SDK persistence. The following event can safely
    // append display metadata after its user message, including in bounded History reads.
    this.saveCommandDisplay();
    let display: CommandDisplay | undefined;
    if (event.type === "message_start" && event.message.role === "user") {
      display = this.queuedCommandDisplays.get(event.message) ?? this.startingCommandDisplay;
      this.startingCommandDisplay = undefined;
    }
    const completion = this.transcript.handle(event, display);
    switch (event.type) {
      case "agent_start":
        this.started ??= { wall: Date.now(), monotonic: performance.now() };
        this.result = undefined;
        this.status = "working";
        this.error = null;
        this.aborted = false;
        break;
      case "message_start": {
        const request = deliveredRequest(event.message, display);
        if (request) {
          this.request = request;
        }

        break;
      }
      case "auto_retry_start":
        this.status = "working";
        break;
      case "compaction_start":
        this.started ??= { wall: Date.now(), monotonic: performance.now() };
        this.compacting = true;
        this.status = "working";
        break;
      case "compaction_end":
        // Manual control restores its settled status in compact() before clearing
        // this activity; otherwise an end-event snapshot flashes the old request.
        if (!this.controlling) {
          this.compacting = false;
        }
        break;
      case "message_update":
        if (event.message.role === "assistant") {
          this.partial = event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
        }
        break;
      case "message_end":
        if (event.message.role === "user" && this.transcript.commandDisplay(event.message)) {
          this.commandToSave = event.message;
        }
        this.partial = "";
        break;
      case "tool_execution_start":
        this.activeTools.set(event.toolCallId, `Running ${event.toolName}`);
        break;
      case "tool_execution_update":
        this.activeTools.set(
          event.toolCallId,
          `Running ${event.toolName}: ${toolText(event.partialResult)}`,
        );
        break;
      case "tool_execution_end":
        this.activeTools.delete(event.toolCallId);
        break;
      case "agent_settled":
        this.started = undefined;
        this.aborted = event.aborted;
        this.status = this.finalStatus(event.aborted);
        this.telemetry.refreshUsage();
        break;
      // agent_end may precede retry/compaction/follow-up; never mark it complete.
    }
    if (completion) {
      // Resolve the delivered request once at settlement, not by scanning transcripts for each monitor update.
      // Stop at the previous run boundary so autonomous work cannot borrow an older request title.
      this.request = undefined;

      const sections = this.transcript.sections;
      for (let index = sections.length - 1; index >= 0; index--) {
        const section = sections[index]!;
        if (section.completion && section.completion !== completion) {
          break;
        }
        if (section.request) {
          this.request = section.request;
          break;
        }
      }

      this.result = {
        id: crypto.randomUUID(),
        outcome: completion.outcome,
        completedAt: completion.completedAt,
        ...(this.request ? { request: this.request } : {}),
        ...(completion.outcome === "cancelled" && (this.closing || this.interrupting)
          ? { cancellation: this.closing ? ("lifecycle" as const) : ("user" as const) }
          : {}),
      };
      // Optional display persistence cannot turn an accepted, settled action into a rejected run.
      try {
        const saved = saveRunCompletion(this.session.sessionManager, completion);
        if (!saved.ok) {
          this.transcript.warnCompletion(
            completion,
            `[${saved.error.code}] Run finished, but saving its timing could not be confirmed.`,
          );
        }
      } catch (error) {
        this.transcript.warnCompletion(
          completion,
          reportUnexpected(error, "run timing persistence"),
        );
      }
    }

    this.emit();
  }

  private displayForMessage(message: AgentSession["messages"][number]): CommandDisplay | undefined {
    const display = this.transcript.commandDisplay(message);
    if (display || message.role !== "user" || !this.transcript.hasCommandDisplays) return display;
    const leafId = this.session.sessionManager.getLeafId();
    if (this.commandProjection?.leafId !== leafId) {
      this.commandProjection = {
        leafId,
        ids: this.session.sessionManager
          .buildSessionProjection()
          .entries.flatMap((entry) => entry.messages.map(() => entry.sourceEntry.id)),
      };
    }
    const id = this.commandProjection.ids[this.session.messages.indexOf(message)];

    return this.transcript.commandDisplay(message, id);
  }

  private saveCommandDisplay(): void {
    const message = this.commandToSave;
    if (!message) return;
    this.commandToSave = undefined;
    const parts = this.transcript.commandDisplay(message);
    const entry = this.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message === message);
    if (!parts || !entry) {
      this.ui?.context.notify(
        "Command was accepted, but saving its display metadata could not be confirmed.",
        "warning",
      );
      return;
    }
    this.transcript.rememberCommandId(message, entry.id);
    try {
      this.session.sessionManager.appendCustomEntry(commandDisplayEntryType, {
        messageId: entry.id,
        parts,
      });
      const manager = this.session.sessionManager;
      // SDK History uses firstMessage when unnamed; an initial command needs an
      // invocation-based default instead of exposing the expanded instructions.
      if (
        !manager.getSessionName() &&
        manager.getBranch().find((item) => item.type === "message" && item.message.role === "user")
          ?.id === entry.id
      ) {
        this.session.setSessionName(
          parts
            .map((part) => part.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .slice(0, 120),
        );
      }
    } catch (error) {
      const expected = knownError(error);
      const warning = expected
        ? `[${expected.code}] Command was accepted, but saving its display metadata could not be confirmed.`
        : reportUnexpected(error, "command display persistence");
      this.transcript.notice("Command display persistence", warning, "error");
      this.ui?.context.notify(warning, "warning");
    }
  }

  private finalResponse(): string | undefined {
    if (this.status !== "complete") return undefined;
    const last = this.session.messages.findLast((message) => message.role === "assistant");
    if (
      last?.role !== "assistant" ||
      (last.stopReason !== "stop" && last.stopReason !== "length") ||
      last.content.some((part) => part.type === "toolCall")
    )
      return undefined;
    return last.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  private finalStatus(aborted: boolean): ExecutionState["status"] {
    const last = this.session.messages.findLast((message) => message.role === "assistant");
    if (!last || last.role !== "assistant" || aborted || last.stopReason === "aborted") {
      return null;
    }
    if (last.stopReason === "error") {
      this.error = last.errorMessage ?? "Agent failed.";

      return "failure";
    }

    return last.stopReason === "stop" || last.stopReason === "length" ? "complete" : null;
  }

  private emit(): void {
    this.scheduleSubagentNotifications();
    // SDK model switching can emit an intermediate automatic effort before the explicit choice.
    if (!this.modelSelectionSnapshot) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}

function deliveredRequest(
  message: AgentSession["messages"][number] | undefined,
  display?: CommandDisplay,
): RequestSummary | undefined {
  if (message?.role !== "user") {
    return undefined;
  }

  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  const skill = parseSkillBlock(text);

  return summarizeRequest(
    display
      ? display.map((part) => part.text).join("\n")
      : skill
        ? skill.userMessage || `/skill:${skill.name}`
        : text,
    typeof message.content === "string"
      ? 0
      : message.content.filter((part) => part.type === "image").length,
  );
}

async function modelOperation<T>(operation: () => Promise<T>): Promise<Result<T, ExpectedError>> {
  try {
    return await capture(operation);
  } catch (error) {
    if (error instanceof ModelsError) {
      return err(
        new ModelSelectionError(
          "Could not load or apply model configuration. Check the provider authentication and settings before retrying.",
          { cause: error },
        ),
      );
    }

    throw error;
  }
}

function saveRunCompletion(
  manager: SessionManager,
  completion: RunCompletion,
): Result<void, ExpectedError> {
  try {
    manager.appendCustomEntry(runCompletionEntryType, completion);

    return ok(undefined);
  } catch (error) {
    const expected = knownError(error);
    if (expected) {
      return err(expected);
    }

    throw error;
  }
}

function toolText(result: unknown): string {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return "";
  }

  return result.content
    .flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}
