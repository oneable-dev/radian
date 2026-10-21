import { discoverRepository } from "../workspace/discovery.ts";
import { discoverWorkspace } from "../workspace/roots.ts";
import { loadWorkspaceConfig } from "../workspace/config.ts";
import { WorkspaceClient } from "../runtime/workspace-client.ts";
import { demoWorkspace } from "../workspace/demo.ts";
import { WorkspaceSelection } from "./workspace-selection.ts";
import { submitAgentPrompt } from "./agent-prompt.ts";
import type { Repository } from "../workspace/model.ts";
import { connectRuntime, defaultPreferences, fetchSnapshot } from "../runtime/client.ts";
import type { RuntimePreferences, WorkViewPreferences } from "../runtime/protocol.ts";
import { restoreWorkViews, saveWorkViews } from "../runtime/work-view-preferences.ts";
import { capture, ConnectionError, InputError, reportUnexpected, type ExpectedError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import { loadKeymap, type Keymap } from "../keybindings/config.ts";
import { loadTheme, type ThemeOverrides } from "../ui/theme-config.ts";
import { readTerminalProcessTitles } from "../terminal/process-titles.ts";
import type { CliOptions as Options } from "./cli.ts";

export async function main(options: Options): Promise<Result<void, ExpectedError>> {
  if (options.service) {
    const { runRuntime } = await import("../runtime/service.ts");
    return capture(() => runRuntime(options.cwd, options.offline, options.stateRoot));
  }
  const administrative = options.stop || options.status;
  if (administrative) return runAdministrative(options);
  const keymap = await loadKeymap(options.keybindings);
  if (!keymap.ok) return keymap;
  const theme = await loadTheme(options.theme);
  if (!theme.ok) return theme;
  let repositories: readonly Repository[] = [];
  let discoveryError: string | null = null;
  if (options.demo) repositories = demoWorkspace();
  else {
    const config = options.offline ? ok({ roots: [], maxDepth: 0 }) : await loadWorkspaceConfig(options.workspaceConfig);
    if (!config.ok) return config;
    if (!config.value.roots.length) {
      const discovered = await discoverRepository(options.cwd);
      if (discovered.ok) repositories = [discovered.value];
      else discoveryError = discovered.error.message;
    } else {
      const discovered = await discoverWorkspace(config.value); if (!discovered.ok) return discovered;
      repositories = discovered.value.repositories;
      discoveryError = discovered.value.warnings.map(({ path, error }) => `${path}: [${error.code}] ${error.message}`).join(" · ") || (repositories.length ? null : "No Git repositories found in workspace roots.");
    }
  }
  const connected = !options.demo && repositories.length ? await WorkspaceClient.open(repositories, options.cwd, {
    offline: options.offline, ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
  }) : ok(null);
  if (!connected.ok) return connected;
  const client = connected.value;
  try {
    const selected = client?.snapshot.preferences.selection.worktreeId;
    if (client && selected) {
      const activated = await client.activate(selected);
      if (!activated.ok) discoveryError = [discoveryError, activated.error.message].filter(Boolean).join(" · ");
    }
    await runUI(repositories, client, options, discoveryError, keymap.value, theme.value);
    return ok(undefined);
  } finally { await client?.disconnect(); }
}

// Administrative commands remain scoped to the launching repository, never every scan root.
async function runAdministrative(options: Options): Promise<Result<void, ExpectedError>> {
  const discovered = await discoverRepository(options.cwd);
  if (!discovered.ok) return err(new InputError(discovered.error.message, { cause: discovered.error }));
  const connected = await connectRuntime(discovered.value, options.cwd, { offline: options.offline,
    ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}), start: false });
  if (!connected.ok) return connected;
  const client = connected.value;
  try {
    if (!client) { console.log("No running workspace service."); return ok(undefined); }
    if (options.status) { console.log(JSON.stringify(client.snapshot, null, 2)); return ok(undefined); }
    if (client.snapshot.editors?.some((editor) => !editor.exited)) console.error("Stopping the runtime also closes Neovim. Unsaved editor buffers are not restored after restart; save them before using --stop-runtime.");
    if (client.snapshot.terminals?.length) console.error("Stopping the runtime also closes all terminal shells and their owned jobs.");
    const stopped = await client.stopRuntime(); if (!stopped.ok) return stopped;
    const deadline = Date.now() + 15000;
    while (true) {
      const snapshot = await fetchSnapshot(client.paths); if (!snapshot.ok) return snapshot;
      if (!snapshot.value) break;
      if (Date.now() > deadline) return err(new ConnectionError("CONNECTION_TIMEOUT", "Runtime shutdown has not completed; its outcome is not confirmed."));
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    console.log("Workspace service stopped. Open-session state and saved history were retained.");
    return ok(undefined);
  } finally { await client?.disconnect(); }
}

async function runUI(repositories: readonly Repository[], client: WorkspaceClient | null, options: Options, discoveryError: string | null, keymap: Keymap, theme: ThemeOverrides): Promise<void> {
  const { createCliRenderer, destroyTreeSitterClient } = await import("@opentui/core");
  const { Workbench } = await import("./ui/workbench.ts");
  const { GitRepository } = await import("../git/repository.ts");
  const { TerminalTheme } = await import("../ui/embedded-terminal/theme.ts");
  const { TerminalNotifications } = await import("./terminal-notifications.ts");
  const { SessionNotifications } = await import("./session-notifications.ts");
  const { CompletionCache } = await import("../agents/completion-cache.ts");
  const { uiTheme } = await import("../ui/theme.ts");
  const { monochromeFrame } = await import("../ui/monochrome.ts");
  let attachedTheme: ReturnType<typeof uiTheme> | undefined;
  const selection = new WorkspaceSelection(client?.snapshot.repositories ?? repositories);
  const preferences: RuntimePreferences = client ? structuredClone(client.snapshot.preferences) : defaultPreferences();
  if (client) selection.restore(preferences.selection);
  const renderer = await createCliRenderer({ exitOnCtrlC: false,
    ...(options.noColor ? { postProcessFns: [(buffer) => monochromeFrame(buffer, attachedTheme?.colors, attachedTheme?.styles)] } : {}) });
  attachedTheme = uiTheme(renderer); attachedTheme.setMonochrome(options.noColor);
  let view: InstanceType<typeof Workbench> | undefined;
  let sessionNotifications: InstanceType<typeof SessionNotifications> | undefined;
  const detachHint = keymap.hint("app.detach", "none") || "No detach binding";
  const defaultMessage = discoveryError ?? (options.demo ? `DEMO · display fixtures only · ${detachHint} detaches` : options.offline
    ? `OFFLINE SDK · scripted slow / read / write / delegate · ${detachHint} detaches`
    : "");
  let message = defaultMessage;
  const updateNotice = (): void => {
    const closing = (client?.snapshot.closingCount ?? 0) + (client?.snapshot.terminalClosingCount ?? 0);
    view?.setNotice([client?.snapshot.notice || message, closing ? `Closing ${closing}` : ""].filter(Boolean).join(" · "));
  };
  const showFailure = (error: ExpectedError): void => { message = `[${error.code}] ${error.message}`; updateNotice(); };
  const unexpected = (error: unknown): void => { message = reportUnexpected(error, "UI action"); updateNotice(); };
  const notifications = client ? new TerminalNotifications(renderer, client, unexpected) : undefined;
  const completions = client ? new CompletionCache((id, signal) => client.catalog(id, signal), id => client.completionIdentity(id), unexpected) : undefined;
  const warmCompletions = (): void => {
    if (!client || !completions) return;
    const snapshot = client.snapshot, ids = new Set<string>();
    for (const repo of snapshot.repositories) for (const tree of repo.worktrees) for (const session of tree.sessions) {
      // Do not activate cold repository services just to populate suggestions.
      if (!snapshot.details[session.id]?.conversationId) continue;
      ids.add(session.id); completions.provider.prepare?.(session.id, tree.path);
    }
    completions.provider.retain?.(ids);
  };
  const observe = <T>(task: Promise<Result<T, ExpectedError>>): void => {
    void task.then((result) => { if (!result.ok) showFailure(result.error); }).catch(unexpected);
  };
  let pendingPreferences: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  let lastPreferences = JSON.stringify(preferences);
  let activatedWorktree = selection.worktree?.id ?? null;
  const persist = (): void => {
    const current = selection.state;
    const sessions = { ...preferences.selection.sessions, ...current.sessions };
    for (const tree of selection.snapshot.flatMap((repo) => repo.worktrees)) {
      if (client?.hasSnapshot(tree.id) && !current.sessions[tree.id]) delete sessions[tree.id];
    }
    preferences.selection = { worktreeId: current.worktreeId, sessions };
    if (client && current.worktreeId !== activatedWorktree) {
      activatedWorktree = current.worktreeId;
      if (activatedWorktree) observe(client.activate(activatedWorktree));
    }
    const key = JSON.stringify(preferences);
    if (!client || key === lastPreferences) return;
    lastPreferences = key;
    const state = structuredClone(preferences);
    pendingPreferences = pendingPreferences.then(() => client.savePreferences(state));
    observe(pendingPreferences);
  };
  const unsubscribeSelection = selection.subscribe(persist);
  let recovery = client?.recoveryVersion ?? 0;
  const unsubscribe = client?.subscribe(() => {
    const restored = recovery !== client.recoveryVersion;
    recovery = client.recoveryVersion;
    if (restored) message = defaultMessage;
    selection.replaceSnapshot(client.snapshot.repositories, preferences.selection.sessions);
    warmCompletions();
    if (restored) view?.refreshHistory();
    updateNotice();
  });
  const detach = (): void => {
    sessionNotifications?.dispose(); notifications?.dispose(); completions?.dispose(); unsubscribe?.(); unsubscribeSelection();
    if (view) { preferences.drafts = view.promptDrafts; preferences.inputDrafts = view.promptInputDrafts; persist(); }
    const mounted = view; view = undefined; mounted?.dispose(); client?.beginDetach(); renderer.destroy();
  };
  try {
    warmCompletions();
    renderer.setTerminalTitle("radian");
    const palette = await renderer.getPalette({ size: 256, timeout: 200 });
    uiTheme(renderer).configure(palette, theme);
    const terminalTheme = new TerminalTheme(renderer, palette);
    view = new Workbench(renderer, selection, {
      keymap, onDetach: detach, terminalTheme,
      onNotice: (text) => { message = text; updateNotice(); },
      onNewSession: (worktreeId, onCreated) => {
        if (!client) { message = "Demo creation request · no agents running"; updateNotice(); return; }
        observe(client.create(worktreeId).then(result => {
          if (result.ok) onCreated?.(result.value);
          return result;
        }));
      },
      onCloseSession: (worktreeId, sessionId) => {
        if (client) { observe(client.closeSession(sessionId)); return; }
        selection.replaceSnapshot(selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== worktreeId ? tree : {
          ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
        }) })));
        message = "Demo item removed · no runtime or saved history was modified"; updateNotice();
      },
      ...(client ? {
        onPrompt: async (id: string, text: string, images?: readonly string[]) => {
          const result = await submitAgentPrompt(client, selection, id, text, images);
          if (!result.ok || text.trim() !== "/reload") return result;
          const refreshed = await completions!.refresh(id);
          // SDK reload was accepted. A local indexing failure is a warning, not a rejected action.
          message = refreshed.ok ? "Resources and completion indexes reloaded."
            : `Resources reloaded, but completion refresh failed [${refreshed.error.code}]: ${refreshed.error.message}`;
          updateNotice(); return result;
        },
        onInterrupt: (id: string) => client.interrupt(id),
        onAcknowledge: (id: string, conversationId: string, resultId: string) => client.acknowledge(id, conversationId, resultId),
        getMonitoringNotice: () => client.attentionNotice,
        onComplete: completions!.provider,
        onListModels: (id, conversationId, signal) => client.models(id, conversationId, signal),
        onSelectModel: (id, conversationId, model, effort) => client.selectModel(id, conversationId, model, effort),
        onImage: (id, imageId, signal) => client.image(id, imageId, signal),
        git: {
          source: (worktree) => new GitRepository(worktree.path),
          createSession: (worktreeId) => client.create(worktreeId),
          prompt: (sessionId, text, images) => client.prompt(sessionId, text, images),
        },
        getSessionDetails: (id: string) => client.snapshot.details[id] ?? null,
        onListHistory: (worktreeId, signal) => client.listHistory(worktreeId, signal),
        onPreviewHistory: (worktreeId, savedId, signal) => client.previewHistory(worktreeId, savedId, signal),
        onResumeSession: (worktreeId: string, savedId: string) => client.resume(worktreeId, savedId),
        initialDrafts: preferences.drafts,
        ...(preferences.inputDrafts ? { initialInputDrafts: preferences.inputDrafts } : {}),
        getRetainedSessionIds: () => client.retainedSessionIds,
        onDraftChange: (drafts, inputs) => { preferences.drafts = drafts; preferences.inputDrafts = inputs; persist(); },
        initialWorkViews: restoreWorkViews(preferences),
        onWorkViewsChange: (workViews: WorkViewPreferences) => { saveWorkViews(preferences, workViews); persist(); },
        terminal: {
          list: () => client.snapshot.terminals ?? [],
          titles: readTerminalProcessTitles,
          create: (worktreeId, size) => client.createTerminal(worktreeId, size),
          attach: (id, frame, failed) => client.attachTerminal(id, frame, failed),
          close: (id) => client.closeTerminal(id),
        },
        editor: {
          info: (worktreeId: string) => client.snapshot.editors?.find((editor) => editor.worktreeId === worktreeId),
          open: (worktreeId: string, size) => client.openEditor(worktreeId, size),
          attach: (id, frame, failed) => client.attachEditor(id, frame, failed),
        },
      } : {}),
    });
    if (client) sessionNotifications = new SessionNotifications(client, notification => view?.notifySession(notification));
    updateNotice(); await renderer.closed;
  } finally {
    sessionNotifications?.dispose(); notifications?.dispose(); completions?.dispose(); unsubscribe?.(); unsubscribeSelection();
    preferences.drafts = view?.promptDrafts ?? preferences.drafts;
    if (view) preferences.inputDrafts = view.promptInputDrafts;
    persist();
    const mounted = view; view = undefined; mounted?.dispose(); client?.beginDetach(); renderer.destroy(); await renderer.closed;
    await destroyTreeSitterClient();
    const saved = await pendingPreferences;
    if (!saved.ok) console.error(`[${saved.error.code}] Could not save UI preferences: ${saved.error.message}`);
  }
}
