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
`Ctrl+Space`, then `c`, **detaches the TUI only**. Agents and subagents keep running in a separate local service.
These are default application bindings; see [Keybindings](#keybindings) to customize them.

```sh
bun run start --demo  # Display fixture sessions/subagents and exercise selection and closing
```

On first launch, default mode has no open sessions and creates independent **Pi SDK sessions**
only on explicit requests. Later launches reattach to the existing service and restore its open items,
last-selected worktree/session, input drafts and current output. Model selection and provider credentials use Pi configuration. Submitting
a prompt in default mode can make real model requests and run coding tools in that worktree.
Additional sessions do not forcibly replace the current selection. Each session retains its input
draft while switching worktrees. Submitting during an active run uses Pi's existing steering queue:
the message enters after the current assistant turn and its tools, before the next response. This is
not follow-up-after-task behavior and does not interrupt or replace the running session. Both Agent
and Git callers use the same runtime prompt path. The runtime acknowledges SDK acceptance separately
from run completion; input is retained until acceptance, and rejection/unknown timeout outcomes do
not automatically replay a prompt. No separate queue-management or follow-up mode UI is added.

`--demo` remains display-only: closing removes fixture metadata and creation only reports a
request. It does not invoke Pi, access credentials, or create stored sessions.
The History tab lists saved SDK conversations for the selected worktree and opens them explicitly.
The Agent view remains a minimal execution interface, not the finished conversation editor.
The Editor view embeds Neovim; Git provides a native, read-only history and whole-file diff UI.

### Work views

The left panel retains Workspace/History navigation. The right panel switches between **Agent**,
**Editor**, **Git** and **Terminal**, with one visible view per worktree and Agent as the initial view.
Selecting a worktree restores its last view; explicitly selecting a session (including History resume)
selects that session and switches to Agent, even if that worktree previously showed Editor or Git.
Search and background snapshots do not override the active view. Session creation/closing retain
their existing rules and never implicitly launch an editor.

Every worktree remembers its active tab. Agent retains its selected session, draft and transcript
scroll position; Neovim retains its actual files, cursor, editing mode and unsaved buffers in the
detached runtime. Terminal retains its shell list, selected shell and log viewport. All four views
restore on TUI reconnect while that runtime remains alive.
Git restores its internal tabs, ref filter, selected commit/file, comparison and scroll positions.
Only view identities/positions are stored in the additive `gitViews` preference, not file contents
or requests to replay. Git data is read again on a fresh TUI attachment. Demo mode remains display-only.
See **Native Git** below for the supported operations and resource limits.

Select Editor to explicitly open/attach Neovim. Worktree navigation and reconnect attach an existing
editor without restarting it. If no process remains after runtime restart, the view offers an explicit
open action instead of silently replacing lost editing state. `:q`/`:qa` remain Neovim's commands;
when Neovim exits the Editor tab stays selected and offers an explicit reopen action.

While the embedded terminal is focused, Neovim receives Tab, Esc, Ctrl+f/e, mouse and paste.
**Ctrl+]** moves focus to the visible sidebar; outside the editor, existing application focus keys
and Tab/Shift+Tab traversal work. **Ctrl+C is native input**, not an application detach binding.
Use the configured detach sequence (default **Ctrl+Space, then c**). The footer follows the actual
focused control and effective keymap. Opening, switching and resizing do not
send a prompt to an agent or run a Git mutation. Entering Git may perform read-only queries.

### Native Git

Git has **Commits / Reflog** navigation. Commits shows the colored commit history or a file comparison
in the main area, with **Commit / Refs** tabs on the right. Commit contains details and changed files;
Refs contains Local / Remote / Tags and an All refs action. Reflog uses the full width and hides the
right panel. The application's Workspace sidebar stays; Git does not duplicate worktree navigation
or provide submodules. Selecting a ref filters history, never checks it out.

The initial selection is Working tree, with staged, unstaged and untracked changes. A commit compares
against its first parent (or empty content for a root commit). Staged compares HEAD/index, unstaged
compares index/worktree, and untracked compares empty/worktree. A staged rename followed by an
unstaged edit uses the new index path. Git queries disable optional locks and external diff/textconv;
they never stage, commit, push or change branches.

Selecting a changed file replaces **only the main history area** with a whole-file Before / After
comparison. The right file list stays available, and selecting another file updates the comparison.
Both columns share one keyboard-focus target and synchronized wheel/keyboard scrolling. Esc or
Back returns to the prior history position. No collapsed-context feature is required: unchanged
content is included, not silently omitted by a default short-context patch.

Git-specific actions are scoped to Git browsing controls and can be rebound in the normal keymap:

| Focus | `a`: attach to an Agent prompt | `y`: copy the complete identifier |
| --- | --- | --- |
| Commit history row | Commit hash only | Full hash |
| Commit details | Full metadata, message and tags | Full hash |
| Changed file / entire Diff | Relative path and historical revision/change identity | Relative path |
| Local / Remote branch | Name only; no automatic tip hash | Name, including remote prefix |
| Tag | Name only | Name |
| Reflog | Event details and target hash | Full target hash |

`a` freezes the chosen context and opens a small prompt with a session selector. The default is the
last selected session in that worktree; New session creates one only when Send is pressed. Enter
submits through the same runtime path as Agent input, including SDK steering when busy. Esc cancels.
The existing Agent draft is untouched, and sending keeps Git visible. No extra execution-status or
Agent-navigation panel is added. Prompt typing treats a/y as ordinary text; A/Y actions do not exist.

Click selects; dragging selects text without activating a row. Releasing a drag automatically copies
its text, excluding graph decorations and line numbers. Split comparisons clamp selection to the
starting code column. `y` still copies the focused object's identifier, regardless of text selection.
Local clipboard writes use OpenTUI's clipboard service. Remote terminals use OSC52 when available,
without writing an unrelated remote host clipboard. OSC52 is reported as a **request sent**, not
confirmed clipboard contents; unsupported/failed delivery is reported explicitly. Real SSH terminal
acceptance depends on the terminal/multiplexer configuration and is not assumed from dispatch alone.

Arrows/j/k navigate, Enter selects, r refreshes, + loads another 300 commits, Home/End jump, and
PgUp/PgDn scroll. Diff arrows scroll both columns (left/right horizontally). History is bounded to
3,000 commits per ref filter. Text preview is bounded to 1 MiB per version and 20,000 combined lines;
Git command output is bounded to 4 MiB with a 10-second query timeout. Exceeding a preview/computation
limit, binary content, gitlinks and unmerged files produce an explicit notice rather than a partial
successful preview. Three-way conflict resolution and Git mutation actions are out of scope.

Rendering uses the existing OpenTUI `DiffRenderable`, directly declared jsdiff 9.0.0 for full-context
patch construction, and the pinned web-tree-sitter 0.25.10 peer. JavaScript/JSX, TypeScript/TSX,
Markdown and Zig use the bundled grammars; other file types remain readable without syntax colors.
The graph lane routing ports the user's `nvim/lua/git/graph.lua`; Git does not require Neovim,
lazygit, delta or difftastic. Tree-sitter workers are released when the TUI detaches.

### Terminal tabs

Select **Terminal**, then **+ New** (or the configured new-terminal command). Merely viewing an
empty Terminal view never launches a shell. Each worktree has an independent list of shells;
creating one selects it unless a later navigation action supersedes that request. **Close** removes
the selected tab and selects its next/previous neighbor, or leaves an explicit empty state.

The default shell is the runtime's `SHELL`, falling back to `/bin/sh`, started interactively in the
selected worktree. Normal mode uses its ordinary user configuration. Test runtime uses a clean
`/bin/sh` with no `ENV`/`BASH_ENV` startup file and no history file. **Shell commands are real even
in test runtime; this is not a filesystem/process sandbox.** No model is invoked by shell input.

The embedded terminal's default foreground/background and ANSI palette follow the outer terminal's
reported theme, including after a TUI reconnect. Programs' explicit RGB colors are preserved. If the
outer terminal cannot report a color, the embedded renderer keeps its fallback for that color.

Shells and development servers keep running when switching tabs/worktrees or detaching the TUI.
When a shell exits, its tab closes automatically and its remaining owned jobs are cleaned up through
the same verified close procedure. The next/previous tab is selected, or the view remains empty;
no replacement shell is started. Automatic cleanup also runs while the TUI is detached.
There are up to **5,000 scrollback lines per shell in memory**, navigated with the wheel
or default Shift+PgUp/PgDn. Typing returns to live output. History/viewport survive warm reconnect;
radian does not save terminal output/commands to its manifest. A live shell may save its own
history according to its user configuration.

Closing a tab stops its shell and other processes in its **owned POSIX session**, including ordinary
foreground/background development servers. Each tab retains a Bun supervisor as the
session ownership anchor until its cleanup completes, including after shell exit. The runtime verifies
the live anchor and kernel `getsid()` membership before signaling **individual positive PIDs only**. It never uses `ps sess`
values or negative/group/broadcast kills, and refuses cleanup on lost ownership. Graceful termination
is followed by bounded escalation for still-owned processes; failures remain tracked and are reported.
`runtime-status` reports the supervisor `pid` separately from `shellPid`.

This boundary does not claim control over processes that intentionally escape into another session,
remote services, privileged jobs the user cannot terminate, or arbitrary effects of shell commands.
Hard runtime death may leave processes behind; there is no automatic command replay or cold shell
recreation. Explicit `--stop-runtime` closes all tracked terminals and their owned jobs. Existing
services without `terminal-tabs` are not silently upgraded. The new view preference is stored in
additive fields so the original three-view wire enum remains readable by older clients.

### Theme

The UI follows the attached terminal by default: text/background use its default colors, while
accents, status indicators and Git graph/syntax colors use its ANSI palette. Muted text, selection,
footer and diff backgrounds are derived from those colors for both light and dark terminals.
Reported palette changes repaint the UI without restarting the runtime or losing prompt drafts,
focus or Git navigation/scroll positions. Each attached TUI has its own theme.

Navigation uses understated separators and underlined active tabs rather than boxed controls.
Sidebar, work-view content and footer text use two-cell horizontal insets, reduced to one on terminals
narrower than 80 columns. Work-view content has one blank row above and below; screens shorter than
18 rows drop that vertical padding. The sidebar widens to retain room for its tree. Embedded programs
receive the measured inner viewport rather than rendering beneath the padding. The footer remains
one row, with its gradient extending through the product text's inset to the screen's left edge.
Keyboard focus is separate from selection: the focused sidebar or input border uses the terminal's
accent, while an unfocused selection stays softly highlighted. Agent input has a dedicated surface.
These are presentation changes only; keybindings and embedded program input ownership are unchanged.

No theme file is required. Optional `#RRGGBB` color overrides are read at TUI startup from
`$XDG_CONFIG_HOME/radian/theme.json`, falling back to `~/.config/radian/theme.json`.
Use `--theme PATH` to choose an explicit file. For example:

```json
{
  "accent": "#7DD3FC",
  "selected": "#1E3A5F"
}
```

Available roles: `text`, `panel`, `surface`, `muted`, `selected`, `accent`, `success`, `error`,
`warning`, `info`, `keyword`, `number`, `added` and `removed`. Omitted roles continue to follow the
terminal; derived roles use the overridden base colors. Missing optional files use the terminal
theme; invalid files or missing explicit paths are errors. Restart only the TUI after editing a file.

If color queries are unsupported, native default/ANSI color intent is retained. Derived colors use
fallback snapshots (light when the terminal reports light mode, dark otherwise); explicit overrides
can correct them. Overrides affect Radian's UI only: embedded shells still follow the host terminal,
and programs' explicit RGB colors or Neovim colorschemes remain unchanged.

### Keybindings

The default leader is **Ctrl+Space**. Press and release it, then press `c` to detach radian,
`1`/`2`/`3`/`4` to select Agent/Editor/Git/Terminal, `w` to focus the sidebar or `f` to focus search.
`<leader> t` creates a terminal, `<leader> x` closes the selected terminal, and `<leader> [` / `]`
select the previous/next terminal while the Terminal view is active.
Ctrl+C is not intercepted by default: Neovim and shells receive it as native input.
If macOS reserves Ctrl+Space for input-source switching, change that system shortcut or radian's leader.

Settings are read when the TUI starts from `$XDG_CONFIG_HOME/radian/keybindings.json`, falling back
to `~/.config/radian/keybindings.json`. `--keybindings PATH` selects an explicit file. Restart only
the TUI to apply edits; the runtime and its processes do not need restarting. There is no settings UI yet.

```json
{
  "leader": "ctrl+space",
  "timeoutMs": 1000,
  "bindings": {
    "app.detach": ["<leader> c"],
    "view.editor": ["<leader> e"],
    "session.new": [{ "keys": "s", "scope": "workspace" }]
  }
}
```

Spaces separate sequential keys (`"space r"` is a two-key leader); `+` combines modifiers.
Use explicit `shift+c` for uppercase C. A string binding is global; an object can specify `scope`:
`global`, `app` (outside PTYs), `pty`, `workspace`, `search`, `history`, `prompt`, `button`,
`transcript`, `editor`, `terminal`, or `none`. An override replaces that command's defaults;
`[]` disables it. Command IDs/defaults are defined in `src/keybindings/commands.ts`.
Unknown commands, invalid keys and overlapping/prefix bindings are errors rather than silent fallbacks.
For example, a printable Space leader conflicts with the default button Space activation unless that
binding is changed. Missing default files use defaults; missing explicitly requested files are errors.

Incomplete/mismatched sequences are returned once, in order, to their original input target. Focus
changes flush the old prefix to the old target, never the newly selected terminal. Paste is never
interpreted as commands, and kitty key-release events do not duplicate replayed text. These settings
control radian commands, not Neovim's own configuration or shell editing bindings. Configured but
currently unavailable commands are consumed without executing, never replayed as accidental edits.

### Common footer

The left navigation and right work panel share one full-width footer. The bottom row shows `Radian`
and its version on the left and shortcuts for the **currently focused control** on the right. A subtle
background gradient starts at the screen's left edge, including the product text's inset, and fades
the terminal's accent into the footer surface toward the right. It follows palette changes and optional theme overrides. Keys are highlighted separately
from their descriptions. Tree, search, History, buttons and prompt contexts update on actual focus/state changes; unrelated/global shortcuts are not appended.
Application bindings such as `Ctrl+f`, `Ctrl+e` and `Tab` still work outside Neovim input focus;
the configured leader detach command works in every input context. See the input ownership rules above.

Errors and service notices occupy a separate row immediately above the footer, so they never
replace shortcut hints. The existing fixed-height notice allocation and status-icon legend are
preserved; the legend sits above the notice row. This avoids adding an unapproved hide/show policy.
The footer itself is read-only: clicking it neither runs an action nor takes input focus.

The footer stays one line on narrow terminals. Identity stays on the left; complete shortcut/label
pairs fit in the owner's supplied order and trailing pairs are omitted with an ellipsis. Resize
restores them when space permits. There is no extra Help action or invented priority category.
`src/ui/footer.ts` is a reusable presentation component; it does not own keyboard handlers,
workspace selection, or agent execution.

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

Event subscriptions send the current snapshot every 5 s while idle, keeping `GET /events` alive
without disabling ordinary request timeouts. These heartbeat snapshots use the existing protocol and
do not run agents or write checkpoints. A heartbeat is used because the installed Bun 1.4.3 can still
time out streaming Unix requests after `server.timeout(request, 0)`.
On an unexpected disconnect, the TUI makes at most four read-only resubscription attempts after
250 ms, 500 ms, 1 s, and 2 s. Each attempt must receive headers and a valid first snapshot within 2 s.
A connection must remain healthy for 10 s before a later disconnect receives a fresh retry budget;
a peer that repeatedly opens and closes cannot retry indefinitely. Permission/protocol failures and
unexpected programming errors stop recovery rather than being treated as transient outages.
A successful subscription restores the latest snapshot and refreshes visible history. If recovery
stops, the notice asks you to use the configured detach command and reopen radian. Detaching cancels pending retries.
Reconnection never launches/restarts a service or replays prompts, creation, closing, or other commands.
A replacement service is accepted only for the same repository and live/test mode. Services already
running older code still require an explicit stop/restart after their jobs finish to load these fixes.

A main-subscription interruption invalidates attached PTY input handles and discards their unsent
input rather than allowing old keystrokes to run after recovery. The underlying Neovim/shell processes
are not closed. After the main subscription recovers, reconnect the editor or select/reconnect the
terminal explicitly; a new attachment does not relaunch its process. Already-sent input can have an
uncertain outcome and is never resent. Intentional TUI detach stops subscription retries immediately,
while draining already-queued healthy PTY input once and allowing final preference writes.

Commands and PTY attachments include an `X-Radian-Instance` fence. Services advertising
`instance-guard` reject requests for a different instance before accepting actions or leases. Older
clients may omit the header, and older services need an explicit upgrade for server-side fencing.
A late acknowledgement remains an acknowledgement of the original accepted action, but does not
replace notices belonging to a recovered connection or new service.

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

### Work-view runtime foundation

The additive `work-views` capability provides a daemon-owned Neovim per worktree and optional
work-view preferences, used by the right-panel UI above.
Neovim must be installed as `nvim` on the daemon's PATH; normal mode uses your Neovim configuration,
while `--test-runtime` launches it with `--clean -i NONE -n` (no user plugins, ShaDa or swap files). `--demo` never launches an editor.
Editor integration tests require Neovim as well as Bun and Git.

The service owns Bun PTYs and bounded VT screens (`@xterm/headless`): Neovim uses zero scrollback,
while shells retain the bounded history described above. A local encoder uses public visible-cell
APIs, including after a resize shrinks retained rows.
Attachments receive complete ANSI screen/mode snapshots, not an ever-growing
or truncated byte history. Buffer contents are retained by the **same Neovim process** while a TUI
is absent. Terminal contents are not written to radian's checkpoint. The UI uses the existing
OpenTUI terminal renderer; the headless screen exists to support reconnects without restarting Neovim.

Each PTY allows one input/resize attachment at a time. Generation IDs and attachment leases reject
stale inputs, and input is ordered, bounded and never replayed. Detaching releases the attachment, not
the process. An exited editor is reopened only by an explicit action. No Git operations or lazygit
integration are provided by this capability. Legacy manifests remain readable; older clients do not
clear work-view preferences they do not understand. Older services are never automatically restarted.

Runtime/editor snapshot streams send heartbeats every 5 seconds to keep long-lived idle views alive
under Bun's HTTP idle timeout. Slow readers receive only the latest complete snapshot.
The configured detach command closes only the TUI. **Explicit `--stop-runtime` also terminates Neovim**:
save buffers first. Runtime restart/reboot does not restore unsaved editor buffers or automatically
launch an editor, even when a saved tab preference points to Editor.

### Shared terminal layers

`src/runtime/pty/session.ts` owns a PTY, bounded VT screen and input/resize lease independently
of the launched program. `src/editor/sessions.ts` retains Neovim launch, one-editor-per-worktree,
and editor compatibility policies; `src/terminal/sessions.ts` owns shell-tab lifecycle policies.
`src/runtime/pty/client.ts` owns ordered IPC input and frame attachment; its caller supplies the
channel-specific commands. `src/runtime/pty/screen.ts` encodes visible terminal cells.
`src/ui/embedded-terminal/surface.ts` handles native rendering/input and viewport synchronization,
while each feature's panel decides when to display or reconnect. Editor and Terminal share these
technical layers; neither feature depends on the other's implementation.

### Saved session history

Select a worktree, then open **History**. The list uses SDK-provided conversation names (falling back
to the first prompt or `Untitled session`), last activity and message count, newest first. It is scoped
to that worktree even when the offline session directory is shared. Viewing or refreshing history
never starts a model run or creates an open item. `Refresh history` / `r` reloads the selected scope;
empty, loading, discovery and resume failures have distinct messages. The heading's shared loading
spinner stays animated for at least 500 ms, without delaying results or errors. Leaving the tab or
destroying the view cancels it immediately; the same component/policy applies to other UI loaders.

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

## Source organization

The source is organized by feature ownership, with shared runtime and presentation infrastructure.
This is an incremental domain-oriented layout, not a requirement to give every feature identical
`domain/application/infrastructure` directories.

| Directory | Responsibility |
| --- | --- |
| `src/app/` | CLI/UI bootstrap, workspace selection and whole-application composition |
| `src/app/ui/workbench.ts` | Overall layout, left navigation, view switching, focus and footer coordination; no separate Sidebar abstraction |
| `src/agents/` | Agent session/subagent models and lifecycle, saved History and Pi SDK integration |
| `src/agents/ui/` | Agent transcript/prompt/drafts/scroll and saved-History panel, regardless of where they appear on screen |
| `src/editor/` | Worktree Neovim lifecycle and its UI panel |
| `src/terminal/` | Shell-tab lifecycle, ownership supervisor/cleanup and its UI panel |
| `src/git/` | Read-only Git queries, comparisons and Agent context; Git-specific rendering lives in `ui/` |
| `src/workspace/` | Repository/worktree discovery, snapshot models and search projection |
| `src/runtime/` | Detached service, IPC, recovery, checkpoints and shared `pty/` implementation |
| `src/keybindings/` | Application commands, binding configuration and input routing |
| `src/ui/` | Shared footer, loading feedback, theme and embedded-terminal presentation |
| `src/testing/` | Isolated repositories, scripted SDK responses and test helpers |

`src/index.ts` is the executable entry point. `app/bootstrap.ts` wires the runtime and feature
interfaces; features do not import the workbench. Keep feature runtime modules independent of their
`ui/` subdirectories: co-location does not mean they execute in the same process. Do not add barrel
exports that load OpenTUI when the daemon imports Agent, Editor or Terminal lifecycle code.
Workspace models remain outside `app`; the workbench owns tree rows and navigation presentation.
The existing repository/worktree snapshot still includes Agent summaries for compatibility, not
execution ownership. Wire schemas and checkpoint formats remain in `runtime/protocol.ts` unchanged.

Tests live beside their feature or integration owner. Whole-workbench tests are under `app/ui/`;
feature interaction tests may compose the real workbench. Pure file moves do not change renderable
IDs, key commands, runtime namespaces or saved-session identifiers. View-controller separation and
further model/transport decoupling are follow-up work, not implied by the folder names.

## Repository

https://github.com/oneable-dev/radian

## License

This project is licensed under the [MIT License](LICENSE).
