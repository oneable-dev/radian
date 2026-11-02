import { discoverRepository } from "../workspace/discovery.ts";
import { loadSettings, workspaceSource } from "./settings.ts";
import { WorkspaceClient } from "../runtime/workspace-client.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";
import { submitAgentPrompt } from "./agent-prompt.ts";
import { currentUiIdentity, retainedUiDrafts, UiStateStore, type UiState } from "./ui-state.ts";
import {
  initialView,
  recordWorktreeOwners,
  UiStatePersistence,
  WorkspaceDeletions,
  worktreeOwners,
} from "./workspace-deletion.ts";
import { CHAT_SCOPE_ID } from "../agents/session-scope.ts";
import type { Repository } from "../workspace/model.ts";
import { defaultPreferences, fetchSnapshot, RuntimeClient } from "../runtime/client.ts";
import { connectRuntime, ensureSharedDaemon } from "../runtime/lifecycle.ts";
import { probeSnapshot } from "../runtime/snapshot-probe.ts";
import { selfLaunch, type SelfLaunch } from "../runtime/launch.ts";
import { daemonPaths } from "../runtime/storage.ts";
import type { RuntimePreferences, WorkViewPreferences } from "../runtime/protocol.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";
import {
  capture,
  ConnectionError,
  InputError,
  reportUnexpected,
  type ExpectedError,
} from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { Keymap } from "../keybindings/config.ts";
import type { ThemeOverrides } from "../ui/theme-config.ts";
import { readTerminalProcessTitles } from "../terminal/process-titles.ts";
import { readWorkspaceResources } from "../usage/workspace-resources.ts";
import { sessionSources } from "./session-sources.ts";
import type { CliOptions as Options } from "./cli.ts";

export async function main(
  options: Options,
  launch: SelfLaunch = selfLaunch(),
): Promise<Result<void, ExpectedError>> {
  if (options.service) {
    const { runRuntime } = await import("../runtime/daemon.ts");
    // Launch flags select a workspace source; otherwise the daemon re-reads its remembered one.
    const explicit = options.config || options.workspaceConfig || options.runtimeCwd;
    const source = explicit ? workspaceSource(options) : undefined;

    return capture(() =>
      runRuntime(options.offline, options.stateRoot, {
        ...(source ? { source } : {}),
        ...(options.runtimeAttachChat ? { attachChat: true } : {}),
      }),
    );
  }

  const administrative = options.stop || options.status || options.restart;
  if (administrative) {
    return runAdministrative(options, launch);
  }

  const settings = await loadSettings({
    ...options,
    includeWorkspace: !options.demo && !options.offline,
  });
  if (!settings.ok) {
    return settings;
  }

  // The shared daemon owns workspace membership. The TUI sends its source reference and
  // consumes the catalog the daemon prepared; it never scans roots or registers a list itself.
  const repositories: readonly Repository[] = options.demo ? demoWorkspace() : [];
  const discoveryError: string | null = null;
  const connected = !options.demo
    ? await WorkspaceClient.attach(workspaceSource(options), {
        offline: options.offline,
        launch,
        ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
        ...(options.config ? { config: options.config } : {}),
      })
    : ok(null);
  if (!connected.ok) {
    return connected;
  }

  const client = connected.value;
  try {
    await runUI(
      repositories,
      client,
      options,
      discoveryError,
      settings.value.keymap,
      settings.value.theme,
    );

    return ok(undefined);
  } finally {
    await client?.disconnect();
  }
}

// Ordinary lifecycle commands address the shared owner, independently of cwd or workspace roots.
async function runAdministrative(
  options: Options,
  launch: SelfLaunch,
): Promise<Result<void, ExpectedError>> {
  let client: RuntimeClient | null;
  if (options.legacy) {
    const discovered = await discoverRepository(options.cwd);
    if (!discovered.ok) {
      return err(new InputError(discovered.error.message, { cause: discovered.error }));
    }

    const connected = await connectRuntime(discovered.value, options.cwd, {
      offline: options.offline,
      ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
      start: false,
      launch,
    });
    if (!connected.ok) {
      return connected;
    }

    client = connected.value;
    if (client?.snapshot.capabilities?.includes("shared-daemon")) {
      await client.disconnect();

      return err(
        new InputError("This repository belongs to the shared daemon. Omit --legacy to manage it."),
      );
    }
  } else {
    const paths = daemonPaths(options.offline, options.stateRoot);
    const snapshot = options.restart
      ? await probeSnapshot(paths, Date.now() + 15000)
      : await fetchSnapshot(paths);
    if (!snapshot.ok) {
      return snapshot;
    }

    client = snapshot.value ? new RuntimeClient(paths, snapshot.value) : null;
  }
  try {
    if (!client && !options.restart) {
      console.log("No running workspace service.");

      return ok(undefined);
    }
    if (options.status) {
      console.log(JSON.stringify(client!.snapshot, null, 2));

      return ok(undefined);
    }
    if (client) {
      if (client.snapshot.editors?.some((editor) => !editor.exited)) {
        console.error(
          "Stopping the daemon closes Neovim across all owned repositories. Save unsaved buffers first.",
        );
      }
      if (client.snapshot.terminals?.length) {
        console.error("Stopping the daemon closes all owned terminal shells and their jobs.");
      }
      if (Object.values(client.snapshot.details).some((state) => state.status === "working")) {
        console.error(
          "Stopping the daemon interrupts active Agent work; prompts are not replayed on restart.",
        );
      }

      const stopped = await client.stopRuntime();
      if (!stopped.ok) {
        return stopped;
      }

      const deadline = Date.now() + 15000;
      while (true) {
        const snapshot = await probeSnapshot(client.paths, deadline);
        if (!snapshot.ok) {
          return snapshot;
        }
        if (!snapshot.value) {
          break;
        }
        if (snapshot.value.instance !== client.snapshot.instance) {
          return err(
            new ConnectionError(
              "CONNECTION_FAILED",
              "Another daemon replaced the stopped instance. It was not stopped again.",
            ),
          );
        }
        if (Date.now() >= deadline) {
          return err(
            new ConnectionError(
              "CONNECTION_TIMEOUT",
              "Daemon shutdown has not completed; its outcome is not confirmed.",
            ),
          );
        }

        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now()))),
        );
      }
    }
    if (options.restart) {
      const started = await ensureSharedDaemon({
        launch,
        offline: options.offline,
        ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
      });
      if (!started.ok) {
        return started;
      }

      console.log(
        "Shared daemon restarted. Stored history and open-session intent were retained; interrupted jobs were not replayed.",
      );
    } else {
      console.log("Workspace service stopped. Open-session state and saved history were retained.");
    }

    return ok(undefined);
  } finally {
    await client?.disconnect();
  }
}

async function runUI(
  repositories: readonly Repository[],
  client: WorkspaceClient | null,
  options: Options,
  discoveryError: string | null,
  keymap: Keymap,
  theme: ThemeOverrides,
): Promise<void> {
  const { createCliRenderer, destroyTreeSitterClient } = await import("@opentui/core");
  const { Workbench } = await import("./ui/workbench.ts");
  const { GitRepository } = await import("../git/repository.ts");
  const { TerminalTheme } = await import("../ui/embedded-terminal/theme.ts");
  const { TerminalNotifications } = await import("./terminal-notifications.ts");
  const { SessionNotifications } = await import("./session-notifications.ts");
  const { CompletionCache } = await import("../agents/completion-cache.ts");
  const { PreloadedData } = await import("./preload.ts");
  const { uiTheme } = await import("../ui/theme.ts");
  const { monochromeFrame } = await import("../ui/monochrome.ts");
  let attachedTheme: ReturnType<typeof uiTheme> | undefined;
  const initialWarnings: ExpectedError[] = [];
  let state: UiState = {
    version: 1,
    view: client ? "chat" : "agent",
    chatSessionId: null,
    preferences: client ? structuredClone(client.snapshot.preferences) : defaultPreferences(),
  };
  let uiStore: UiStateStore | undefined;
  if (client) {
    const identity = await currentUiIdentity();
    if (!identity.ok) initialWarnings.push(identity.error);
    uiStore = new UiStateStore(
      daemonPaths(options.offline, options.stateRoot).directory,
      identity.ok ? identity.value : `client:${crypto.randomUUID()}`,
    );
    const loaded = await uiStore.load(
      state.preferences,
      worktreeOwners(client.snapshot.repositories),
    );
    if (loaded.ok) state = loaded.value;
    else initialWarnings.push(loaded.error);
  }
  // load() scrubbed the stored state against the cleanup ledger up to its acknowledged revision.
  const deletions = new WorkspaceDeletions(state, uiStore, uiStore?.acknowledgedCleanup ?? 0);
  // A cleanup scrub before this UI attached (a purge while it was detached, or load itself) may
  // already have cleared the selection; prepare() then has nothing newer but still reports it.
  const selectedDeleted = deletions.prepare(
    client?.snapshot.deletedScopes,
    client?.snapshot.repositories,
    uiStore?.selectionDeleted ?? false,
  );
  if (client) {
    state.view = initialView(state.view, selectedDeleted, client.snapshot.repositories);
  }
  const preferences: RuntimePreferences = state.preferences;
  const selection = new WorkspaceSelection(client?.snapshot.repositories ?? repositories);
  selection.forget({
    worktreeIds: new Set(),
    sessionIds: new Set(
      client?.snapshot.deletedScopes?.scopes.flatMap((scope) => scope.sessionIds) ?? [],
    ),
  });
  selection.restore(preferences.selection);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    ...(options.noColor
      ? {
          postProcessFns: [
            (buffer) => monochromeFrame(buffer, attachedTheme?.colors, attachedTheme?.styles),
          ],
        }
      : {}),
  });
  attachedTheme = uiTheme(renderer);
  attachedTheme.setMonochrome(options.noColor);

  let view: InstanceType<typeof Workbench> | undefined;
  let sessionNotifications: InstanceType<typeof SessionNotifications> | undefined;
  const detachHint = keymap.hint("app.detach", "none") || "No detach binding";
  const defaultMessage =
    discoveryError ??
    (options.demo
      ? `DEMO · display fixtures only · ${detachHint} detaches`
      : options.offline
        ? `OFFLINE SDK · scripted slow / read / write / delegate · ${detachHint} detaches`
        : "");
  const updateNotice = (): void => {
    view?.setNotice(client?.snapshot.notice || defaultMessage, {
      level: client?.snapshot.notice ? "warning" : discoveryError ? "error" : "info",
      source: "Runtime",
    });
  };
  const showFailure = (error: ExpectedError): void => {
    view?.notify(`[${error.code}] ${error.message}`, { level: "error", source: "Runtime" });
  };
  const unexpected = (error: unknown): void => {
    const message = reportUnexpected(error, "UI action");
    view?.notify(message, { level: "error", source: "Runtime" });
  };
  const notifications = client
    ? new TerminalNotifications(renderer, client, unexpected)
    : undefined;
  const completions = client
    ? new CompletionCache(
        (id, signal) => client.catalog(id, signal),
        (id) => client.completionIdentity(id),
        unexpected,
        (id, query, signal) => client.complete(id, query, signal),
      )
    : undefined;
  const preloaded = client ? new PreloadedData(client, unexpected) : undefined;
  const unsubscribeData = preloaded?.subscribe(() => view?.refreshPreloadedData());
  const preloadCompletions = (): void => {
    if (!client || !completions) {
      return;
    }

    const snapshot = client.snapshot;
    const ids = new Set<string>();
    for (const repo of snapshot.repositories) {
      for (const tree of repo.worktrees) {
        for (const session of tree.sessions) {
          // Do not activate cold repository services just to populate suggestions.
          if (!snapshot.details[session.id]?.conversationId) {
            continue;
          }

          ids.add(session.id);
          completions.provider.prepare?.(session.id, tree.path);
        }
      }
    }

    for (const session of snapshot.chat?.sessions ?? []) {
      if (!snapshot.details[session.id]?.conversationId) continue;
      ids.add(session.id);
      completions.provider.prepare?.(session.id, snapshot.chat!.path, { files: false });
    }
    completions.provider.retain?.(ids);
  };
  const preload = (): void => {
    preloadCompletions();
    preloaded?.preloadModels();
    preloaded?.preloadAccounts();
    preloaded?.preloadHistory();
  };
  const observe = <T>(task: Promise<Result<T, ExpectedError>>): void => {
    void task
      .then((result) => {
        if (!result.ok) {
          showFailure(result.error);
        }
      })
      .catch(unexpected);
  };
  const saves = new UiStatePersistence(uiStore, observe);
  let activatedWorktree: string | null = null;
  const persist = (): void => {
    // Selection and draft callbacks fire synchronously while a deletion is applied.
    if (deletions.suspended) {
      return;
    }

    const ownership = (state.sessionScopes ??= {});
    for (const source of sessionSources(client?.snapshot ?? { repositories })) {
      for (const session of source.sessions) {
        if (!deletions.isDeleted(session.id)) ownership[session.id] = source.scopeId;
      }
    }
    // Displayed repositories own their worktree keys; a later deletion of another repository
    // that used the same path then leaves this state alone.
    state.worktreeRepositories = recordWorktreeOwners(state, selection.snapshot);
    const current = selection.state;
    const sessions = Object.fromEntries(
      Object.entries({ ...preferences.selection.sessions, ...current.sessions }).filter(
        ([, id]) => !deletions.isDeleted(id),
      ),
    );
    for (const tree of selection.snapshot.flatMap((repo) => repo.worktrees)) {
      if (client?.hasSnapshot(tree.id) && !current.sessions[tree.id]) {
        delete sessions[tree.id];
      }
    }

    preferences.selection = { worktreeId: current.worktreeId, sessions };
    if (client && state.view !== "chat" && current.worktreeId !== activatedWorktree) {
      activatedWorktree = current.worktreeId;
      if (activatedWorktree) {
        observe(client.activate(activatedWorktree));
      }
    }

    saves.save(state);
  };
  const unsubscribeSelection = selection.subscribe(persist);
  let recovery = client?.recoveryVersion ?? 0;
  const unsubscribe = client?.subscribe(() => {
    const restored = recovery !== client.recoveryVersion;
    recovery = client.recoveryVersion;
    // Explicit deletions only: cold, unavailable or disconnected repositories are not deleted.
    const applied = deletions.apply(client.snapshot.deletedScopes, client.snapshot.repositories, {
      selection,
      ...(view ? { view } : {}),
      persist,
    });
    if (!applied) {
      selection.replaceSnapshot(client.snapshot.repositories, preferences.selection.sessions);
    }
    preload();
    if (restored) {
      view?.refreshHistory();
    }

    updateNotice();
  });
  const detach = (): void => {
    sessionNotifications?.dispose();
    notifications?.dispose();
    completions?.dispose();
    unsubscribeData?.();
    preloaded?.dispose();
    unsubscribe?.();
    unsubscribeSelection();
    if (view) {
      preferences.drafts = deletions.withoutDeleted(view.promptDrafts);
      preferences.inputDrafts = deletions.withoutDeleted(view.promptInputDrafts);
      persist();
    }

    const mounted = view;
    view = undefined;
    mounted?.dispose();
    client?.beginDetach();
    renderer.destroy();
  };
  try {
    preload();
    renderer.setTerminalTitle("radian");

    const palette = await renderer.getPalette({ size: 256, timeout: 200 });
    uiTheme(renderer).configure(palette, theme);

    const terminalTheme = new TerminalTheme(renderer, palette);
    view = new Workbench(renderer, selection, {
      keymap,
      ...(client ? { getChat: () => client.snapshot.chat ?? null } : {}),
      initialView: state.view,
      initialChatSessionId: state.chatSessionId,
      onViewChange: (next) => {
        state.view = next;
        persist();
      },
      onChatSessionChange: (id) => {
        state.chatSessionId = id;
        persist();
      },
      onDetach: detach,
      terminalTheme,
      onNewSession: (worktreeId, onCreated) => {
        if (!client) {
          view?.notify("Demo creation request · no agents running");

          return;
        }

        observe(
          client.create(worktreeId).then((result) => {
            if (result.ok) {
              onCreated?.(result.value);
            }

            return result;
          }),
        );
      },
      onCloseSession: (worktreeId, sessionId) => {
        if (client) {
          observe(client.closeSession(sessionId));

          return;
        }

        selection.replaceSnapshot(
          selection.snapshot.map((repo) => ({
            ...repo,
            worktrees: repo.worktrees.map((tree) =>
              tree.id !== worktreeId
                ? tree
                : {
                    ...tree,
                    sessions: tree.sessions.filter((session) => session.id !== sessionId),
                  },
            ),
          })),
        );
        view?.notify("Demo item removed · no runtime or saved history was modified", {
          level: "success",
        });
      },
      ...(client
        ? {
            onPrompt: async (id: string, text: string, images?: readonly string[]) => {
              const result = await submitAgentPrompt(client, selection, id, text, images, {
                isCurrent: (sessionId) =>
                  view?.currentView === "chat" && view.chatSessionId === sessionId,
                select: (sessionId) => view?.selectChatSession(sessionId),
              });
              if (!result.ok || text.trim() !== "/reload") {
                return result;
              }

              preloaded!.reload();

              const refreshed = await completions!.refresh(id);
              // SDK reload was accepted. A local indexing failure is a warning, not a rejected action.
              view?.notify(
                refreshed.ok
                  ? "Resources and completion indexes reloaded."
                  : `Resources reloaded, but completion refresh failed [${refreshed.error.code}]: ${refreshed.error.message}`,
                { level: refreshed.ok ? "success" : "warning", source: "Reload" },
              );

              return result;
            },
            onInterrupt: (id: string) => client.interrupt(id),
            onAcknowledge: (id: string, conversationId: string, resultId: string) =>
              client.acknowledge(id, conversationId, resultId),
            getMonitoringNotice: () => client.attentionNotice,
            onComplete: completions!.provider,
            preloaded: preloaded!,
            onAccountsRequest: preloaded!.requestAccounts,
            getExtensionUi: () => client.snapshot.extensionUi ?? [],
            onExtensionUiResponse: (id, conversation, response) =>
              client.answerExtensionUi(id, conversation, response),
            onListModels: preloaded!.listModels,
            onSelectModel: (id, conversationId, model, effort) =>
              client.selectModel(id, conversationId, model, effort),
            onImage: (id, imageId, signal) => client.image(id, imageId, signal),
            git: {
              source: (worktree) => new GitRepository(worktree.path),
              createSession: (worktreeId) => client.create(worktreeId),
              prompt: (sessionId, text, images) => client.prompt(sessionId, text, images),
            },
            getSessionDetails: (id: string) => client.snapshot.details[id] ?? null,
            onDashboard: (days, repositoryId, signal) =>
              client.dashboard(days, repositoryId, signal),
            onResources: (signal) => client.resources(signal),
            onWorkspaceResources: (signal) => readWorkspaceResources(client.resourceScopes, signal),
            onListHistory: preloaded!.listHistory,
            onPreviewHistory: (worktreeId, savedId, signal) =>
              client.previewHistory(worktreeId, savedId, signal),
            onResumeSession: (worktreeId: string, savedId: string) =>
              client.resume(worktreeId, savedId),
            initialDrafts: preferences.drafts,
            ...(preferences.inputDrafts ? { initialInputDrafts: preferences.inputDrafts } : {}),
            getRetainedSessionIds: () =>
              new Set([
                ...client.retainedSessionIds,
                ...retainedUiDrafts(state, (scope) =>
                  scope === CHAT_SCOPE_ID
                    ? client.snapshot.chat !== undefined
                    : client.hasSnapshot(scope),
                ),
              ]),
            onDraftChange: (drafts, inputs) => {
              preferences.drafts = deletions.withoutDeleted(drafts);
              preferences.inputDrafts = deletions.withoutDeleted(inputs);
              persist();
            },
            initialWorkViews: restoreWorkViews(preferences),
            onWorkViewsChange: (workViews: WorkViewPreferences) => {
              saveWorkViews(preferences, workViews);
              persist();
            },
            terminal: {
              list: () => client.snapshot.terminals ?? [],
              titles: readTerminalProcessTitles,
              create: (worktreeId, size) => client.createTerminal(worktreeId, size),
              attach: (id, frame, failed) => client.attachTerminal(id, frame, failed),
              close: (id) => client.closeTerminal(id),
            },
            editor: {
              info: (worktreeId: string) =>
                client.snapshot.editors?.find((editor) => editor.worktreeId === worktreeId),
              open: (worktreeId: string, size) => client.openEditor(worktreeId, size),
              attach: (id, frame, failed) => client.attachEditor(id, frame, failed),
            },
          }
        : {}),
    });
    if (client) {
      sessionNotifications = new SessionNotifications(client, (notification) =>
        view?.notifySession(notification),
      );
    }

    for (const warning of initialWarnings) {
      view.notify(`[${warning.code}] UI state: ${warning.message}`, {
        level: "warning",
        source: "State",
      });
    }
    persist();
    updateNotice();
    await renderer.closed;
  } finally {
    sessionNotifications?.dispose();
    notifications?.dispose();
    completions?.dispose();
    unsubscribeData?.();
    preloaded?.dispose();
    unsubscribe?.();
    unsubscribeSelection();
    preferences.drafts = deletions.withoutDeleted(view?.promptDrafts ?? preferences.drafts);
    if (view) {
      preferences.inputDrafts = deletions.withoutDeleted(view.promptInputDrafts);
    }

    persist();

    const mounted = view;
    view = undefined;
    mounted?.dispose();
    client?.beginDetach();
    renderer.destroy();
    await renderer.closed;
    await destroyTreeSitterClient();

    const saved = await saves.settled;
    if (!saved.ok) {
      console.error(`[${saved.error.code}] Could not save UI preferences: ${saved.error.message}`);
    }
  }
}
