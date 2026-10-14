# radian

A terminal-based, AI-driven development editor powered by Pi Agent.

## Goal

Build a terminal-based editor that uses Pi Agent to help developers build software with AI.

## Development

Requires Bun 1.4.3 or later.

```sh
bun install --frozen-lockfile
bun run start
```

The app discovers the current Git repository's worktrees and shows an always-expanded
workspace sidebar. Worktree folders and branches share one row. Use `Tab`/`Shift+Tab`
to move focus, arrow keys to select tree items, `n` to create a new session, and `x` to
close the selected session while the tree is focused. Mouse actions are also supported.
`Ctrl+e` focuses the minimal session prompt; `Enter` submits and `Esc` returns to the tree.
`Ctrl+C` **detaches the TUI only**. Agents and subagents keep running in a separate local service.

```sh
bun run start --demo  # Display fixture sessions/subagents and exercise selection and closing
```

On first launch, default mode has no open sessions and creates independent **Pi SDK sessions**
only on explicit requests. Later launches reattach to the existing service and restore its open items,
last-selected worktree/session, input drafts and current output. Model selection and provider credentials use Pi configuration. Submitting
a prompt in default mode can make real model requests and run coding tools in that worktree.
Additional sessions do not forcibly replace the current selection. Each session retains its input
draft while switching worktrees. Submitting during an active run is rejected with the draft retained;
steering/follow-up UI policy is not implemented.

`--demo` remains display-only: closing removes fixture metadata and creation only reports a
request. It does not invoke Pi, access credentials, or create stored sessions.
The History tab lists saved SDK conversations for the selected worktree and opens them explicitly.
The full editor/inspector remains deferred; the central panel is a minimal execution probe, not the
finished conversation editor.

### Runtime ownership and closing

A detached Bun service owns the registry and an independent SDK instance for each open item,
with an explicit worktree `cwd`. The TUI uses private Unix-domain HTTP/NDJSON to send actions
and receive snapshots; it never owns or disposes SDK executions. macOS/Linux are the supported
local-service platforms for this implementation.
Changing selection/search never calls SDK `switchSession()`, aborts an execution, or changes
`process.cwd()`. Nonselected sessions continue streaming and publishing snapshots.
The `radian_subagent` tool creates an owned SDK child in the same worktree and waits for its result.
Children cannot delegate further. Finished children retain display metadata but release execution
resources. Pi CLI extensions/MCP launchers and their terminal-specific UI are not loaded in this
initial host; context files, skills and prompt templates use SDK discovery. Cache warming is disabled.

Closing immediately removes the UI item and applies the existing next/previous/empty fallback.
The registry retains its closing handle, rejects new work, and cancels the main agent and every
owned child concurrently. It waits for tool completion, then releases resources/subscriptions.
Late events cannot resurrect a closed row. Cleanup failures are surfaced and retained for retry
on explicit service shutdown; repeated close requests coalesce. Disconnecting or crashing the TUI
does not abort work or remove open items. Creation/closing operations also finish independently
of the originating UI connection.
Stored JSONL history is never deleted or forked by closing. The registry's `create(worktreeId, file)`
API reopens the same saved session; the History tab uses this same-file resume boundary. Duplicate writers,
including attempts to reopen while closing, are rejected. Unused-session persistence follows
SDK defaults: a session with no user/assistant exchange may not have a history file.

### Test real SDK switching without a paid model

```sh
bun run test:workspace
```

This creates an **isolated temporary Git repository** with `main` and `feature/probe` linked
worktrees and different `workspace.txt` markers. It does not add worktrees/branches to this
repository. Follow the printed `cd` and `bun ... --test-runtime` commands, then create a session
in each worktree and submit these scripted commands:

- `slow`: a ten-second SDK response stream; switch worktrees and return to inspect progress.
- `read`: invoke the real SDK read tool on the selected worktree's `workspace.txt`.
- `write`: invoke the real SDK write tool on `radian-probe.txt` in the selected worktree.
- `delegate`: invoke `radian_subagent` with an owned slow SDK child; close its parent while working.

**`--test-runtime` uses scripted model responses, not real AI.** It uses isolated credentials/settings
and no provider requests, while exercising the real SDK session, tools, persistence and cancellation.
Test mode uses a stable isolated directory per repository, separate from live-mode state and
credentials. It reconnects to the same test service after TUI exit, instead of making a new temporary
session store. Stop the test service before removing the fixture directory. Never treat these results as live-provider
validation. Use `bun run start` for real provider execution after configuring Pi authentication.

### Service lifetime and recovery

The service starts automatically on first connection. Its Unix socket is user-private (directory
`0700`, socket `0600`), and manifests/logs use private files. No TCP port is exposed.
State defaults to `~/.radian/workspaces/<identity>/`; use `--state-dir PATH` or `RADIAN_STATE_DIR`
to isolate another instance. Identity includes the canonical Git repository, state root and live/test
mode, so launching from different worktrees attaches to the same service.

```sh
bun run start --runtime-status                   # Inspect this repository's existing service
bun run start --stop-runtime                     # Explicitly stop its service and owned executions
bun run start --test-runtime --runtime-status    # Inspect the separate offline service
bun run start --test-runtime --stop-runtime      # Stop the separate offline service
```

These administrative commands do not start a missing service. `--stop-runtime` retains open-session
intent and saved history; it is different from closing a session, which removes that open item.

- **Warm reconnect:** the same service PID, SDK instances, owned children and ongoing output survive
  TUI exit. No prompt is replayed or agent restarted.
- **Service restart/reboot:** open IDs, selection, drafts and saved contexts are restored from an atomic
  checkpoint. Previously working agents are marked interrupted/unreported; model requests and tool
  calls are **not** automatically replayed. Submit a new prompt explicitly to continue.
- **Missing/corrupt saved history:** recovery reports an error rather than silently making an empty
  replacement. Unused items without a history file can be restored as empty items with the same UI ID.
- **Force-killed service:** SDK executions stop and stale endpoints are recovered on the next launch.
  Unlike graceful stop, hard crashes cannot guarantee cleanup of arbitrary tool subprocesses.

The central probe displays a bounded recent transcript (12 messages / 12,000 characters), not the
complete conversation editor or Orca's terminal scrollback. Full SDK history remains in JSONL.
Pi CLI extensions/MCP and remote-machine services are still outside this initial host.

### Saved session history

Select a worktree, then open **History**. The list uses SDK-provided conversation names (falling back
to the first prompt or `Untitled session`), last activity and message count, newest first. It is scoped
to that worktree even when the offline session directory is shared. Viewing or refreshing history
never starts a model run or creates an open item. `Refresh history` / `r` reloads the selected scope;
empty, loading, discovery and resume failures have distinct messages.

Click a row, or `Tab` into the list and use arrows/Home/End plus `Enter`, to open its saved context.
The original SDK session ID/file is retained without copying/forking; the open item becomes selected
in Workspace. Already-open records select their existing item rather than create a second writer.
Closing records and active owned-child writers are unavailable until cleanup finishes. Completed
SDK child conversations can also appear in SDK history; this initial list does not invent a history
retention/deletion or main-only filtering policy. History has no deletion action or name search;
the top search field remains the existing workspace-name projection.

History lookup is a capability added to the existing service protocol. A service started before this
feature keeps its running jobs and is **not** automatically restarted. The UI reports that it lacks
history support; finish its jobs and explicitly stop/restart that service to enable the new capability.

### Error contracts

Expected failures use `Result<T, E>` (`ok`/`err` in `src/result.ts`) and custom errors from
`src/errors.ts`. Session/history/storage/client operations return a failure value with a stable
code such as `SESSION_BUSY`, `SESSION_CONFLICT`, `HISTORY_CORRUPT`, or `STORAGE_FAILED`.
Callers branch on the discriminant rather than catch or match human-readable messages.

Exception-based SDK/OS calls classify only known failures and preserve their cause. Unexpected
exceptions keep their original stack and are logged at the service/UI boundary. SDK tools convert
failed Results to rejection because that is the SDK tool contract. Cleanup keeps both the original
and cleanup errors instead of replacing the first failure.

IPC preserves error codes and distinguishes invalid input (400), state conflicts (409), unavailable
history (404), and operational/internal failures (500). A command already accepted before a
checkpoint failure returns success **with a persistence warning**; it is not safe to replay that
command as if it had been rejected. A connection timeout reports an uncertain action outcome.
Only a missing/refused endpoint triggers service bootstrap, not permission errors or timeouts.
Older daemon string errors are explicitly tagged `LEGACY_REMOTE_ERROR`; existing services are
not automatically restarted to upgrade error handling.

### Workspace search

Click the search field, press `Ctrl+f`, or use `Tab` to focus it. Results update while typing,
deleting or pasting, without submitting the field. Matching is case-insensitive, literal substring
search over repository names, worktree folder names and actual branch names only.
Repository-name matches retain all worktrees; folder/branch matches retain the matching worktree,
its parent repository, and every open session/subagent underneath. Session and subagent titles,
paths, status text and history are not searched.

Press `Esc` in the search field to clear the query and restore the complete tree. Press `Enter`
to focus the workspace results. No matches shows a sidebar message, not a new central empty
session state. Filtering changes only the displayed tree: the current worktree/session selection
and source snapshots stay intact, even when selected items are hidden. Keyboard tree navigation
uses the visible results, and host snapshot changes are re-filtered with the current query.
No Git commands or runtime operations are triggered by search input.

### Display status

Repository and worktree rows retain their Nerd Font type icons. Session rows aggregate the
main agent and subagents: any failure wins, otherwise any working agent keeps the session
working, and completion requires every agent to have completed. Subagent rows display their
own status. Selection and focus do not change execution-state icons.

The SDK adapter normalizes events into display snapshots. `agent_end` alone is not completion:
automatic retries keep the run working, and `agent_settled` plus the final outcome determine
completion/failure. Aborted or unreported outcomes use the neutral robot icon, never successful
completion. Additional idle/waiting/cancelled icon policies are not defined here.

Use a Nerd Font-enabled terminal to view the glyphs. Current mappings are `nf-cod-repo`
(U+EA62), `nf-cod-folder` (U+EA83), `nf-cod-loading` (U+EB19), `nf-cod-pass` (U+EBA4),
`nf-cod-error` (U+EA87), and `nf-cod-robot` (U+EC20), from Nerd Fonts 3.5.1. Headless tests
verify code-point output, not font installation or actual terminal glyph appearance.

```sh
bun run dev        # Run the TUI during development
bun run typecheck  # Check TypeScript types
bun run test       # Run unit and OpenTUI headless interaction tests
```

## Repository

https://github.com/oneable-dev/radian

## License

This project is licensed under the [MIT License](LICENSE).
