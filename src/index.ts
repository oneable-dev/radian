import { discoverRepository } from "./workspace/git.ts";
import { demoWorkspace } from "./workspace/demo.ts";
import { WorkspaceSelection } from "./workspace/selection.ts";
import type { Repository } from "./workspace/model.ts";
import { connectRuntime, defaultPreferences, fetchSnapshot, type RuntimeClient } from "./runtime/client.ts";
import type { RuntimePreferences } from "./runtime/protocol.ts";
import { capture, ConnectionError, InputError, reportUnexpected, type ExpectedError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

type Options = { demo: boolean; offline: boolean; service: boolean; status: boolean; stop: boolean; cwd: string; stateRoot: string | undefined };
function parseOptions(args: string[]): Result<Options, InputError> {
  const values = new Map<string, string>();
  for (const name of ["--state-dir", "--runtime-cwd"]) {
    const index = args.indexOf(name); if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return err(new InputError(`Missing value for ${name}`));
    values.set(name, value);
  }
  const demo = args.includes("--demo"), offline = args.includes("--test-runtime");
  if (demo && offline) return err(new InputError("Choose --demo or --test-runtime, not both."));
  return ok({ demo, offline, service: args.includes("--runtime-service"), status: args.includes("--runtime-status"), stop: args.includes("--stop-runtime"),
    cwd: values.get("--runtime-cwd") ?? process.cwd(), stateRoot: values.get("--state-dir") });
}
async function main(): Promise<Result<void, ExpectedError>> {
  const parsed = parseOptions(process.argv.slice(2)); if (!parsed.ok) return parsed;
  const options = parsed.value;
  if (options.service) {
    const { runRuntime } = await import("./runtime/service.ts");
    return capture(() => runRuntime(options.cwd, options.offline, options.stateRoot));
  }
  let repositories: readonly Repository[] = [];
  let discoveryError: string | null = null;
  if (options.demo) repositories = demoWorkspace();
  else {
    const discovered = await discoverRepository(options.cwd);
    if (discovered.ok) repositories = [discovered.value];
    else discoveryError = discovered.error.message;
  }
  const administrative = options.stop || options.status;
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
      const stopped = await client.stopRuntime(); if (!stopped.ok) return stopped;
      const deadline = Date.now() + 15000;
      while (true) {
        const snapshot = await fetchSnapshot(client.paths); if (!snapshot.ok) return snapshot;
        if (!snapshot.value) break;
        if (Date.now() > deadline) return err(new ConnectionError("CONNECTION_TIMEOUT", "Runtime shutdown has not completed; its outcome is not confirmed."));
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }
      console.log("Workspace service stopped. Open-session state and saved history were retained.");
    } else await runUI(repositories, client, options, discoveryError);
    return ok(undefined);
  } finally { await client?.disconnect(); }
}

async function runUI(repositories: readonly Repository[], client: RuntimeClient | null, options: Options, discoveryError: string | null): Promise<void> {
  const { createCliRenderer } = await import("@opentui/core");
  const { WorkspaceView } = await import("./ui/workspace.ts");
  const selection = new WorkspaceSelection(client?.snapshot.repositories ?? repositories);
  const preferences: RuntimePreferences = client ? structuredClone(client.snapshot.preferences) : defaultPreferences();
  if (client) selection.restore(preferences.selection);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let view: InstanceType<typeof WorkspaceView> | undefined;
  let message = discoveryError ?? (options.demo ? "DEMO · display fixtures only" : options.offline
    ? "OFFLINE SDK · scripted slow / read / write / delegate · Ctrl+C detaches"
    : "Pi SDK service · Ctrl+e prompt · Ctrl+C detaches; agents keep running");
  const updateNotice = (): void => view?.setNotice(`${client?.snapshot.notice || message}${client?.snapshot.closingCount ? ` · Closing ${client.snapshot.closingCount}` : ""}`);
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
  const unsubscribe = client?.subscribe(() => { selection.replaceSnapshot(client.snapshot.repositories); updateNotice(); });
  const quit = (key: import("@opentui/core").KeyEvent): void => {
    if (!key.ctrl || key.name !== "c") return;
    key.preventDefault(); key.stopPropagation(); unsubscribe?.(); unsubscribeSelection();
    const mounted = view; view = undefined; mounted?.dispose(); renderer.destroy();
  };
  renderer.keyInput.on("keypress", quit);
  try {
    view = new WorkspaceView(renderer, selection, {
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
        onPrompt: (id: string, text: string) => { observe(client.prompt(id, text)); },
        getSessionDetails: (id: string) => client.snapshot.details[id] ?? null,
        onListHistory: (worktreeId: string) => client.listHistory(worktreeId),
        onResumeSession: (worktreeId: string, savedId: string) => client.resume(worktreeId, savedId),
        initialDrafts: preferences.drafts,
        onDraftChange: (drafts: Record<string, string>) => { preferences.drafts = drafts; persist(); },
      } : {}),
    });
    updateNotice(); await renderer.closed;
  } finally {
    renderer.keyInput.off("keypress", quit); unsubscribe?.(); unsubscribeSelection();
    preferences.drafts = view?.promptDrafts ?? preferences.drafts; persist();
    const mounted = view; view = undefined; mounted?.dispose(); renderer.destroy(); await renderer.closed;
    const saved = await pendingPreferences;
    if (!saved.ok) console.error(`[${saved.error.code}] Could not save UI preferences: ${saved.error.message}`);
  }
}

try {
  const result = await main();
  if (!result.ok) { console.error(`[${result.error.code}] ${result.error.message}`); process.exitCode = 1; }
} catch (error) { reportUnexpected(error, "application"); process.exitCode = 1; }
