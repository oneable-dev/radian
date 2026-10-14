import { createCliRenderer } from "@opentui/core";
import { WorkspaceView } from "./ui/workspace.ts";
import { demoWorkspace } from "./workspace/demo.ts";
import { discoverRepository, GitDiscoveryError } from "./workspace/git.ts";
import { WorkspaceSelection } from "./workspace/selection.ts";
import type { Repository } from "./workspace/model.ts";

const demo = process.argv.includes("--demo");
let repositories: readonly Repository[] = [];
let discoveryError: string | null = null;
if (demo) repositories = demoWorkspace();
else {
  try {
    repositories = [await discoverRepository(process.cwd())];
  } catch (error) {
    if (!(error instanceof GitDiscoveryError)) throw error;
    discoveryError = error.message;
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
const selection = new WorkspaceSelection(repositories);
let view: WorkspaceView | undefined;
try {
  view = new WorkspaceView(renderer, selection, {
    onNewSession: () => view?.setNotice("New session requested · runtime integration deferred to OA-5"),
    onCloseSession: (worktreeId, sessionId) => {
      if (!demo) {
        view?.setNotice("Session closing requires runtime integration (OA-5)");
        return;
      }
      // Demo-only metadata removal. No real agents or session files exist here.
      selection.replaceSnapshot(selection.snapshot.map((repo) => ({
        ...repo, worktrees: repo.worktrees.map((tree) => tree.id !== worktreeId ? tree : {
          ...tree, sessions: tree.sessions.filter((session) => session.id !== sessionId),
        }),
      })));
      view?.setNotice("Demo item removed · no runtime or saved history was modified");
    },
  });
  if (discoveryError) view.setNotice(discoveryError);
  else view.setNotice(demo ? "DEMO · fixture data only · no agents running" : "UI preview · Git worktrees only · Pi runtime not connected");
  await renderer.closed;
} finally {
  view?.dispose();
  renderer.destroy();
  await renderer.closed;
}
