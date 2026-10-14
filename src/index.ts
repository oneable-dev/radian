import { discoverRepository, GitDiscoveryError } from "./workspace/git.ts";
import { demoWorkspace } from "./workspace/demo.ts";
import { WorkspaceSelection } from "./workspace/selection.ts";
import type { Repository } from "./workspace/model.ts";
import { connectRuntime, defaultPreferences, fetchSnapshot } from "./runtime/client.ts";
import type { RuntimePreferences } from "./runtime/protocol.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
};
const demo = args.includes("--demo");
const offline = args.includes("--test-runtime");
const stateRoot = option("--state-dir");
const cwd = option("--runtime-cwd") ?? process.cwd();
if (demo && offline) throw new Error("Choose --demo or --test-runtime, not both.");
if (args.includes("--runtime-service")) {
  const { runRuntime } = await import("./runtime/service.ts");
  await runRuntime(cwd, offline, stateRoot);
} else {
  let repositories: readonly Repository[] = [];
  let discoveryError: string | null = null;
  if (demo) repositories = demoWorkspace();
  else {
    try { repositories = [await discoverRepository(cwd)]; }
    catch (error) { if (!(error instanceof GitDiscoveryError)) throw error; discoveryError = error.message; }
  }
  const administrative = args.includes("--stop-runtime") || args.includes("--runtime-status");
  if (administrative && !repositories[0]) throw new Error(discoveryError ?? "No repository available.");
  const client = !demo && repositories[0] ? await connectRuntime(repositories[0], cwd, {
    offline, ...(stateRoot ? { stateRoot } : {}), start: !administrative,
  }) : null;
  if (administrative) {
    try {
      if (!client) console.log("No running workspace service.");
      else if (args.includes("--runtime-status")) console.log(JSON.stringify(client.snapshot, null, 2));
      else {
        await client.stopRuntime();
        const deadline = Date.now() + 15000;
        while (await fetchSnapshot(client.paths)) {
          if (Date.now() > deadline) throw new Error("Runtime shutdown has not completed.");
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
        }
        console.log("Workspace service stopped. Open-session state and saved history were retained.");
      }
    } finally { await client?.disconnect(); }
  } else {
    const { createCliRenderer } = await import("@opentui/core");
    const { WorkspaceView } = await import("./ui/workspace.ts");
    const selection = new WorkspaceSelection(client?.snapshot.repositories ?? repositories);
    let preferences: RuntimePreferences = client ? structuredClone(client.snapshot.preferences) : defaultPreferences();
    if (client) selection.restore(preferences.selection);
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    let view: InstanceType<typeof WorkspaceView> | undefined;
    let message = discoveryError ?? (demo ? "DEMO · display fixtures only" : offline
      ? "OFFLINE SDK · scripted slow / read / write / delegate · Ctrl+C detaches"
      : "Pi SDK service · Ctrl+e prompt · Ctrl+C detaches; agents keep running");
    const updateNotice = (): void => view?.setNotice(`${client?.snapshot.notice || message}${client?.snapshot.closingCount ? ` · Closing ${client.snapshot.closingCount}` : ""}`);
    const report = (error: unknown): void => { message = error instanceof Error ? error.message : String(error); updateNotice(); };
    let pendingPreferences = Promise.resolve();
    let lastPreferences = JSON.stringify(preferences);
    const persist = (): void => {
      preferences.selection = { worktreeId: selection.state.worktreeId, sessions: { ...selection.state.sessions } };
      const key = JSON.stringify(preferences);
      if (!client || key === lastPreferences) return;
      lastPreferences = key;
      const state = structuredClone(preferences);
      pendingPreferences = pendingPreferences.catch(() => {}).then(() => client.savePreferences(state));
      void pendingPreferences.catch(report);
    };
    const unsubscribeSelection = selection.subscribe(persist);
    const unsubscribe = client?.subscribe(() => { selection.replaceSnapshot(client.snapshot.repositories); updateNotice(); });
    const quit = (key: import("@opentui/core").KeyEvent): void => {
      if (!key.ctrl || key.name !== "c") return;
      key.preventDefault(); key.stopPropagation();
      unsubscribe?.(); unsubscribeSelection();
      const mounted = view; view = undefined; mounted?.dispose();
      renderer.destroy();
    };
    renderer.keyInput.on("keypress", quit);
    try {
      view = new WorkspaceView(renderer, selection, {
        onNewSession: (worktreeId) => {
          if (!client) { message = "Demo creation request · no agents running"; updateNotice(); return; }
          void client.create(worktreeId).catch(report);
        },
        onCloseSession: (worktreeId, sessionId) => {
          if (client) { void client.closeSession(sessionId).catch(report); return; }
          selection.replaceSnapshot(selection.snapshot.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== worktreeId ? tree : {
            ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
          }) })));
          message = "Demo item removed · no runtime or saved history was modified"; updateNotice();
        },
        ...(client ? {
          onPrompt: (id: string, text: string) => { void client.prompt(id, text).catch(report); },
          getSessionDetails: (id: string) => client.snapshot.details[id] ?? null,
          onListHistory: (worktreeId: string) => client.listHistory(worktreeId),
          onResumeSession: (worktreeId: string, savedId: string) => client.resume(worktreeId, savedId),
          initialDrafts: preferences.drafts,
          onDraftChange: (drafts: Record<string, string>) => { preferences.drafts = drafts; persist(); },
        } : {}),
      });
      updateNotice();
      await renderer.closed;
    } finally {
      renderer.keyInput.off("keypress", quit);
      unsubscribe?.(); unsubscribeSelection();
      preferences.drafts = view?.promptDrafts ?? preferences.drafts; persist();
      const mounted = view; view = undefined; mounted?.dispose();
      renderer.destroy(); await renderer.closed;
      await pendingPreferences.catch((error: unknown) => console.error("Could not save UI preferences:", error));
      // Only the client detaches. No registry shutdown or SDK abort happens in the TUI process.
      await client?.disconnect();
    }
  }
}
