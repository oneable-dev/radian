import { parseSessionControl } from "../agents/session-controls.ts";
import type { ExpectedError } from "../errors.ts";
import { ok, type Result } from "../result.ts";
import type { WorkspaceClient } from "../runtime/workspace-client.ts";
import type { WorkspaceSelection } from "./workspace-selection.ts";

type PromptClient = Pick<WorkspaceClient, "snapshot" | "prompt" | "newTab">;

// Selection is UI-owned. A late creation must not pull the user back from another tab/worktree.
export async function submitAgentPrompt(
  client: PromptClient,
  selection: WorkspaceSelection,
  sessionId: string,
  text: string,
  images: readonly string[] = [],
): Promise<Result<void, ExpectedError>> {
  const control = parseSessionControl(text);
  if (!control.ok) {
    return control;
  }
  if (control.value?.action !== "new-tab" || images.length) {
    return client.prompt(sessionId, text, images);
  }

  const worktree = selection.snapshot
    .flatMap((repo) => repo.worktrees)
    .find((tree) => tree.sessions.some((session) => session.id === sessionId));
  const conversation = client.snapshot.details[sessionId]?.conversationId;
  const created = await client.newTab(sessionId);
  if (!created.ok) {
    return created;
  }
  if (
    worktree &&
    selection.worktree?.id === worktree.id &&
    selection.sessionId === sessionId &&
    client.snapshot.details[sessionId]?.conversationId === conversation
  ) {
    selection.replaceSnapshot(client.snapshot.repositories);
    selection.selectSession(worktree.id, created.value);
  }

  return ok(undefined);
}
