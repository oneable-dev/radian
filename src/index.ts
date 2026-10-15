import { discoverRepository } from "./workspace/git.ts";
import { demoWorkspace } from "./workspace/demo.ts";
import { WorkspaceSelection } from "./workspace/selection.ts";
import type { Repository } from "./workspace/model.ts";
import { connectRuntime, defaultPreferences, fetchSnapshot, type RuntimeClient } from "./runtime/client.ts";
import type { RuntimePreferences, WorkViewPreferences } from "./runtime/protocol.ts";
import { restoreWorkViews, saveWorkViews } from "./runtime/work-view-preferences.ts";
import { capture, ConnectionError, InputError, reportUnexpected, type ExpectedError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { defaultKeymap, loadKeymap, type Keymap } from "./keybindings/config.ts";

type Options = { demo: boolean; offline: boolean; service: boolean; status: boolean; stop: boolean; cwd: string; stateRoot: string | undefined; keybindings: string | undefined };
function parseOptions(args: string[]): Result<Options, InputError> {
  const values = new Map<string, string>();
  for (const name of ["--state-dir", "--runtime-cwd", "--keybindings"]) {
    const index = args.indexOf(name); if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return err(new InputError(`Missing value for ${name}`));
    values.set(name, value);
  }
  const demo = args.includes("--demo"), offline = args.includes("--test-runtime");
  if (demo && offline) return err(new InputError("Choose --demo or --test-runtime, not both."));
  return ok({ demo, offline, service: args.includes("--runtime-service"), status: args.includes("--runtime-status"), stop: args.includes("--stop-runtime"),
    cwd: values.get("--runtime-cwd") ?? process.cwd(), stateRoot: values.get("--state-dir"), keybindings: values.get("--keybindings") });
}
async function main(): Promise<Result<void, ExpectedError>> {
  const parsed = parseOptions(process.argv.slice(2)); if (!parsed.ok) return parsed;
  const options = parsed.value;
  if (options.service) {
    const { runRuntime } = await import("./runtime/service.ts");
    return capture(() => runRuntime(options.cwd, options.offline, options.stateRoot));
  }
  const administrative = options.stop || options.status;
  const keymap = administrative ? ok(defaultKeymap()) : await loadKeymap(options.keybindings);
  if (!keymap.ok) return keymap;
  let repositories: readonly Repository[] = [];
  let discoveryError: string | null = null;
  if (options.demo) repositories = demoWorkspace();
  else {
    const discovered = await discoverRepository(options.cwd);
    if (discovered.ok) repositories = [discovered.value];
    else discoveryError = discovered.error.message;
  }
  if (administrative && !repositories[0]) return err(new InputError(discoveryError ?? "No repository available."));
  const connected = !options.demo && repositories[0] ? await connectRuntime(repositories[0], options.cwd, {
    offline: options.offline, ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}), start: !administrative,
  }) : ok(null);
  if (!connected.ok) return connected;
  const client = connected.value;
  try {
    if (administrative) {
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
    } else await runUI(repositories, client, options, discoveryError, keymap.value);
    return ok(undefined);
  } finally { await client?.disconnect(); }
}

async function runUI(repositories: readonly Repository[], client: RuntimeClient | null, options: Options, discoveryError: string | null, keymap: Keymap): Promise<void> {
  const { createCliRenderer } = await import("@opentui/core");
  const { WorkspaceView } = await import("./ui/workspace.ts");
  const { TerminalTheme } = await import("./ui/terminal-theme.ts");
  const selection = new WorkspaceSelection(client?.snapshot.repositories ?? repositories);
  const preferences: RuntimePreferences = client ? structuredClone(client.snapshot.preferences) : defaultPreferences();
  if (client) selection.restore(preferences.selection);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let view: InstanceType<typeof WorkspaceView> | undefined;
  const detachHint = keymap.hint("app.detach", "none") || "No detach binding";
  const defaultMessage = discoveryError ?? (options.demo ? `DEMO · display fixtures only · ${detachHint} detaches` : options.offline
    ? `OFFLINE SDK · scripted slow / read / write / delegate · ${detachHint} detaches`
    : `Pi SDK service · ${detachHint} detaches; agents/editors/terminals keep running`);
  let message = defaultMessage;
  const updateNotice = (): void => {
    const closing = (client?.snapshot.closingCount ?? 0) + (client?.snapshot.terminalClosingCount ?? 0);
    view?.setNotice(`${client?.snapshot.notice || message}${closing ? ` · Closing ${closing}` : ""}`);
  };
  const showFailure = (error: ExpectedError): void => { message = `[${error.code}] ${error.message}`; updateNotice(); };
  const unexpected = (error: unknown): void => { message = reportUnexpected(error, "UI action"); updateNotice(); };
  const observe = <T>(task: Promise<Result<T, ExpectedError>>): void => {
    void task.then((result) => { if (!result.ok) showFailure(result.error); }).catch(unexpected);
  };
  let pendingPreferences: Promise<Result<void, ExpectedError>> = Promise.resolve(ok(undefined));
  let lastPreferences = JSON.stringify(preferences);
  const persist = (): void => {
    preferences.selection = { worktreeId: selection.state.worktreeId, sessions: { ...selection.state.sessions } };
    const key = JSON.stringify(preferences);
    if (!client || key === lastPreferences) return;
    lastPreferences = key;
    const state = structuredClone(preferences);
    pendingPreferences = pendingPreferences.then(() => client.savePreferences(state));
    observe(pendingPreferences);
  };
  const unsubscribeSelection = selection.subscribe(persist);
  let wasConnected = client?.connected ?? false;
  const unsubscribe = client?.subscribe(() => {
    const restored = !wasConnected && client.connected;
    wasConnected = client.connected;
    if (restored) message = defaultMessage;
    selection.replaceSnapshot(client.snapshot.repositories);
    if (restored) view?.refreshHistory();
    updateNotice();
  });
  const detach = (): void => {
    unsubscribe?.(); unsubscribeSelection();
    const mounted = view; view = undefined; mounted?.dispose(); client?.beginDetach(); renderer.destroy();
  };
  try {
    const terminalTheme = new TerminalTheme(renderer, await renderer.getPalette({ size: 256, timeout: 200 }));
    view = new WorkspaceView(renderer, selection, {
      keymap, onDetach: detach, terminalTheme,
      onNotice: (text) => { message = text; updateNotice(); },
      onNewSession: (worktreeId) => {
        if (!client) { message = "Demo creation request · no agents running"; updateNotice(); return; }
        observe(client.create(worktreeId));
      },
      onCloseSession: (worktreeId, sessionId) => {
        if (client) { observe(client.closeSession(sessionId)); return; }
        selection.replaceSnapshot(selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== worktreeId ? tree : {
          ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
        }) })));
        message = "Demo item removed · no runtime or saved history was modified"; updateNotice();
      },
      ...(client ? {
        onPrompt: (id: string, text: string) => client.prompt(id, text),
        getSessionDetails: (id: string) => client.snapshot.details[id] ?? null,
        onListHistory: (worktreeId: string) => client.listHistory(worktreeId),
        onResumeSession: (worktreeId: string, savedId: string) => client.resume(worktreeId, savedId),
        initialDrafts: preferences.drafts,
        onDraftChange: (drafts: Record<string, string>) => { preferences.drafts = drafts; persist(); },
        initialWorkViews: restoreWorkViews(preferences),
        onWorkViewsChange: (workViews: WorkViewPreferences) => { saveWorkViews(preferences, workViews); persist(); },
        ...(client.supportsTerminals ? { terminal: {
          list: () => client.snapshot.terminals ?? [],
          create: (worktreeId, size) => client.createTerminal(worktreeId, size),
          attach: (id, frame, failed) => client.attachTerminal(id, frame, failed),
          close: (id) => client.closeTerminal(id),
        } } : { terminalUnavailable: "Running service predates terminal tabs. Save work and restart the service explicitly when ready." }),
        editor: {
          info: (worktreeId: string) => client.snapshot.editors?.find((editor) => editor.worktreeId === worktreeId),
          open: (worktreeId: string, size) => client.openEditor(worktreeId, size),
          attach: (id, frame, failed) => client.attachEditor(id, frame, failed),
        },
      } : {}),
    });
    updateNotice(); await renderer.closed;
  } finally {
    unsubscribe?.(); unsubscribeSelection();
    preferences.drafts = view?.promptDrafts ?? preferences.drafts; persist();
    const mounted = view; view = undefined; mounted?.dispose(); client?.beginDetach(); renderer.destroy(); await renderer.closed;
    const saved = await pendingPreferences;
    if (!saved.ok) console.error(`[${saved.error.code}] Could not save UI preferences: ${saved.error.message}`);
  }
}

try {
  const result = await main();
  if (!result.ok) { console.error(`[${result.error.code}] ${result.error.message}`); process.exitCode = 1; }
} catch (error) { reportUnexpected(error, "application"); process.exitCode = 1; }
