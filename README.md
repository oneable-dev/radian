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

The app discovers Git repositories under the configured workspace roots (by default `~/projects`
and `~/.dotfiles`) and shows a workspace sidebar containing **repositories and worktrees only**.
Each worktree shows its folder name and branch on two lines, with the folder and branch icons aligned at the same horizontal level
(no additional branch indentation or connector). Both lines form one selectable worktree item.
Repository groups, headers and worktree items have one blank row between them,
while folder/branch lines stay together. Below 18 terminal rows, item gaps collapse
and repository groups retain one blank row.
The workspace search surface spans the sidebar width with three rows and centered single-line
input. Below 18 terminal rows it collapses to one row; narrow terminals use a shorter placeholder.
The padded search area is clickable and preserves its query and cursor across resize/collapse.
Use `Tab`/`Shift+Tab` to move focus. `j/k`, arrows and Home/End move the tree cursor
without changing the current workspace; **Enter** opens the highlighted worktree and restores its
last work view/session. Mouse clicks open a worktree directly. Open sessions are tabs within Agents;
focus that strip to use `h/l` (or left/right), Home/End, `n` for new and `x` for close.
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
The Agent view provides a keyboard-first, read-only transcript and prompt, not a conversation-content editor.
The Editor view embeds Neovim; Git provides a native, read-only history and whole-file diff UI.

### Workspace roots

Normal mode scans `~/projects` and `~/.dotfiles`, including a root that is itself a repository.
Customize `${XDG_CONFIG_HOME:-~/.config}/radian/workspace.json`, or select another file with
`--workspace-config PATH`:

```json
{
  "roots": ["~/projects", "~/.dotfiles"],
  "maxDepth": 4
}
```

`~` expands to the user's home directory; relative roots resolve against the config file's directory.
Depth starts at zero for each root and is configurable from 0 to 10. An explicit empty `roots` list
uses only the Git repository containing the launching directory. `--test-runtime` always uses that
single-repository scope, and `--demo` never scans user directories.

Discovery stops at repository boundaries, ignores hidden child directories and dependency/build
folders (`node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`, `__pycache__`), and never
follows child symlinks. Explicit symlink roots are supported. Overlapping roots and linked worktrees
are deduplicated using the canonical Git common directory. Each discovered repository includes **all**
its registered worktrees, even ones outside the scan roots. Missing/inaccessible roots and broken
Git metadata produce notices without hiding other repositories. Scans are capped at 10,000
directories and run on TUI launch; reopen the TUI to discover newly added repositories.

The TUI attaches to already-running repository services without restarting them. A cold repository's
service starts only when that repository is selected or explicitly used, not once per scan result.
The launching repository is preferred initially when present, otherwise the first discovered repo.
Prompts, History, editors, terminals and preference writes route to their owning repository service.
Drafts, selected sessions and view state survive lazy attachment; detaching releases this TUI's
connections, not the underlying agents or native processes.

### Work views

The left panel retains Workspace/History navigation. The right panel switches between **Agents**,
**Editor**, **Git** and **Terminal**, with one visible view per worktree and Agents as the initial view.
Tree cursor movement is only navigation; Enter or a direct worktree click commits the selection.
Each worktree separately remembers its work view and selected Agent session. Within Agents, session
tabs show their name and trailing aggregate status, with a close control and explicit new-session
button. Session-tab selection and History resume open the chosen session in Agents. Restoring a
selection, filtering and background snapshots never implicitly activate another work view.
Session creation/closing retain their existing rules and never implicitly launch an editor.

**Ctrl+Space, then b** toggles the entire left panel closed and open, without an extra toolbar button.
The work pane takes the freed width without recreating Agent, Editor or Terminal instances.
Selection, drafts, transcript positions and loaded History rows are retained. Focus/search
commands reveal the panel when needed; hidden navigation controls are excluded from Tab traversal.
This visibility state belongs to the current TUI, not the detached runtime or terminal configuration.

Every worktree remembers its active tab. Agent retains its selected session, draft, transcript
scroll position and section/cursor/folding state; Neovim retains its actual files, cursor, editing mode and unsaved buffers in the
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
Within one TUI, each editor's native surface retains its last screen while hidden. Returning to an
existing editor immediately displays that screen instead of recreating a blank VT. Its old attachment
is still detached, and input stays disabled until a fresh exclusive attachment is acknowledged.
Clicking an already connected Editor focuses it without opening or reconnecting again.

While the embedded terminal is focused, Neovim receives Tab, Esc, Ctrl+f/e, mouse and paste.
**Ctrl+]** moves focus to the visible sidebar; outside the editor, existing application focus keys
and Tab/Shift+Tab traversal work. **Ctrl+C is native input**, not an application detach binding.
Use the configured detach sequence (default **Ctrl+Space, then c**). The footer follows the actual
focused control and effective keymap. Opening, switching and resizing do not
send a prompt to an agent or run a Git mutation. Entering Git may perform read-only queries.

### Prompt completion

The Agent prompt shows a read-only completion menu directly below the input. `/` opens command
suggestions only in the first token at the beginning of the prompt. `@` opens file suggestions at
the beginning of any whitespace-delimited token, including in the middle of a sentence; email
addresses do not trigger it. Matching uses the text before the cursor, not just the end of the draft.
Lookups use a **150 ms trailing debounce**; input, cursor movement and candidate navigation remain
immediate. During refresh the previous candidates and selection stay visible, and the open menu
reserves a stable bounded height, including for loading, errors and no matches. Stale candidates
cannot be inserted until results for the current query arrive. Footer shortcuts retain their positions
and unavailable actions use muted keys instead of disappearing.

- **Ctrl+N / Ctrl+P** selects the next/previous candidate. `hjkl` remains ordinary input.
- **Tab / Enter** inserts the selected candidate without sending the prompt or executing a command.
  Press Enter again after insertion to submit. **Esc** dismisses only the menu and preserves focus/text.
- Selection replaces only the current token, preserving the surrounding text and native Unicode cursor.
  Paths containing spaces, quotes or backslashes use `@"quoted paths"`. File references insert paths,
  not file contents or attachments.

Command candidates come from the selected SDK session's registered extension commands, prompt
templates and enabled Skill commands. Pi CLI-only commands such as `/model` and `/settings` are not
advertised as implemented. Pi's interactive dialogs/custom terminal components are not embedded.
Extension session replacement, tree navigation and reload fail explicitly instead of bypassing Radian's
ownership; commands can wait for the current run to become idle. A handled command without a model
turn preserves the previous status. Command failures retain the draft and report an uncertain action
outcome because an extension may already have changed state; do not blindly retry.

File discovery lists existing tracked and nonignored untracked file paths in the selected session's
worktree. It does not search other worktrees or read file contents. Responses contain at most 100
candidates and indicate when further filtering is needed. Git listing is bounded to 5 seconds and
4 MiB; failures are not replaced by empty successful lists. Session switching, dismissing, hiding or
disposing the menu cancels pending lookups and ignores stale results. Lookup is read-only and never
starts a model turn. The additive `prompt-completion` runtime capability is required: an older service
gets an explicit upgrade notice and is never automatically restarted.

### Agent transcript

An upgraded runtime supplies separate **You**, **Agent**, **Thinking** and **tool execution** sections.
Tool calls and results are joined by call ID, not tool name; unknown tools and MCP bridges use the
same generic interactions. MCP-specific transcript actions are not included.
Tool details start folded; user/Agent text starts expanded. Thinking is always visible prose with
no label or fold controls; old Thinking fold preferences are ignored and cleared. Other nonempty
sections can be folded manually. Error summaries stay visible outside the folded body, and folding never deletes text.
Image attachments have a text placeholder; image rendering is not part of this reader.

A passive **Request** row stays above the scrolling transcript and shows the latest user request
already present in that session's conversation. Whitespace collapses to spaces, and overflowing text
ends with `...` without splitting Unicode graphemes. It consumes only one row, remains after a run
finishes, and restores from the selected session's transcript. Drafts, rejected input and handled
settings commands do not replace it. Sessions without request metadata reserve no row; no request
is inferred from legacy output or session names. This display does not change steer or queue behavior.

Sections have no disclosure arrows or separate role/status heading rows. Expanded user/Agent text
starts directly with its content. Tools use inline invocations such as `[read] path:line` or `$ command`;
folded items show an inline `(Ctrl+o to expand)` hint using the actual configured key. Agent replies
and Thinking have no tinted background, border or added indentation. Thinking uses italic text in
a theme-adaptive neutral gray, independent of accent hues or colored `muted` overrides.
User, tool and notice blocks retain subtle host-palette tints. Sections leave two blank rows between
blocks; screens shorter than 18 rows use one-row gaps and remove internal vertical spacing.

Agent answers and Thinking use OpenTUI's `MarkdownRenderable` for headings, emphasis, links,
lists, fenced code and tables. Tool commands/results, user messages and explicit skill names remain
literal text. Thinking keeps its neutral-gray italic style, including Markdown/code/table content.
Incomplete streaming Markdown updates incrementally; completed messages finalize after native
highlighting, without hiding their initial prose or code while the bundled grammars initialize.

`Enter` on formatted prose opens its **read-only Markdown source** for the existing Vim cursor and
character/logical-line selection commands; the status row identifies `Markdown source`. `Esc` back
to Sections restores formatting. Source offsets and LF/CRLF copying stay exact rather than guessing
positions through hidden Markdown syntax. Section-mode `y` and whole-section `Y` always copy the
original source. The same formatted view is used by read-only History previews.

Built-in Bash invocations append `(timeout 120s)` when that positive timeout was explicitly supplied.
This is the configured execution limit, not elapsed time, a countdown or evidence of cancellation.
No default is invented, and extension-tool timeout units are not guessed. Command previews preserve
newlines, are bounded at 4,096 UTF-16 units and end in an ellipsis when clipped; raw arguments/results
remain available in the expanded body and whole-section copy. Older runtimes without structured
command metadata retain their generic `[bash]` argument summary until explicitly upgraded.

Explicit SDK skill invocation blocks appear as **one-line `[skill] name` items**, with no disclosure
control or expandable instructions. The tag is decorative; copying still copies the name only.
They are excluded from individual and all-section folding, but the name remains navigable/selectable/copyable. Arguments following the invocation remain a separate
user message. A generic `read` of `SKILL.md` stays a tool call; filenames alone do not identify a skill.

Outside an embedded PTY, **Ctrl+T** (or **leader, then o**) enters the transcript. **Ctrl+E** returns
to the input without sending it. All commands are configurable in the existing keymap:

| Mode | Default keys | Action |
| --- | --- | --- |
| Sections | j/k or arrows; Home/End or gg/G | Previous/next or first/last section |
| Sections | Enter | Read Markdown source, folded heading/summary, or literal body with the cursor |
| Sections/Text/Visual | Ctrl+O (also za); zm/zr | Toggle the selected section; fold/unfold all |
| Text/Visual | h/j/k/l or arrows | Grapheme/visual-line cursor movement |
| Text/Visual | w/b; 0/$ or Home/End; gg/G or Ctrl+Home/End | Word, logical-line and section boundaries |
| Text/Visual | v / V | Character selection / whole-logical-line selection; repeat the same key to stop |
| Visual Line | j/k | Move by logical source lines, including wrapped paragraphs |
| Sections/Text/Visual | Ctrl+D / Ctrl+U | Move down/up half the transcript viewport |
| Sections/Text/Visual | y | Copy the section, current logical line, or selected range, respectively |
| Sections/Text/Visual | Y | Copy the whole raw section, including folded details |
| Sections | Ctrl+End | Jump to the actual bottom of the whole transcript and resume following |
| Sections/Text/Visual | ge | Jump to the latest output and resume following |
| Sections/Text/Visual | PgUp/PgDn; F1 | Page; open/close scrollable keyboard help |
| Visual/Text/Sections | Esc | Return to Text, Sections, then Input |
| Sections/Text | i | Return to input |

**Enter never changes folding**. It enters text navigation: a folded section exposes its visible
heading/summary, formatted prose exposes its read-only Markdown source, and other expanded sections
expose their literal body. The decorative skill tag is not part of selectable text. `y` copies the
current source/visible line or selection; `Y` still copies the complete raw section, even when folded. Heading and body cursor positions are retained independently.
Shared Visual bindings also apply to **Visual Line**. `V` selects whole logical lines of the active text surface,
including their original LF/CRLF endings when present, never soft-wrap breaks or an invented EOF
newline. `v`/`V` can switch selection kind while retaining the anchor. Both kinds survive streaming,
resize and warm reconnect. `Ctrl+D/U` scrolls the viewport in Sections and moves the cursor in Text
or Visual; it does not select another section. To jump between sections while reading, press `Esc`
to return to Sections, then j/k (or gg/G). A selection first needs `Esc` to return to Text.

The status row shows the mode, selected section and whether output following is paused. Following
is based on the viewport: at the bottom it follows new output; moving above the bottom pauses it;
returning to the bottom by wheel, scrollbar or paging resumes it automatically. Merely focusing the
transcript does not pause it. Content growth and asynchronous Markdown layout preserve the pre-growth
bottom intent rather than treating the increased scroll range as user navigation. Following also
keeps the bottom on resize and when returning from another work view.

Character/line selections and native mouse selections temporarily protect their viewport. Once
selection is cleared, following resumes only if the viewport is still at the bottom. Auto-following
does not replace a source-mode section, cursor or selection. Help and the read-only History preview
remain independent of live transcript following. `Ctrl+End` in Sections and `ge` explicitly jump to
the whole transcript bottom; `End`/`Shift+G` in Sections still select the last section, and source-mode
`Ctrl+End` still moves to the end of the current section.

A new prompt submission explicitly moves to the bottom without stealing Input focus. Merely editing
an unsent draft or inserting completion text does not discard a reading position above the bottom.
Submission changes follow intent before admission, never from a late acceptance callback: scrolling
away again or switching sessions while admission is pending cannot be overridden by the old result.
Streaming preserves section identity, explicit folding choices, cursor/selection and the viewport
anchor where scrolling permits. Copying preserves raw text, including original line breaks, rather
than inserting display-wrap breaks. Unbound keys, timed-out prefixes and paste cannot edit transcript
content. Help uses the same scroll viewport and returns to the prior position/mode when closed.

After a run actually settles, its final displayed section has a gray footer such as
`Worked for 1m 30s • Sep 19 at 10:55 AM`. Runtime monotonic time measures processing from the first
`agent_start` through final `agent_settled`, including tools, retries, compaction and coalesced queued
follow-ups; intermediate model/tool endings do not finalize it. Queued input joined into one SDK run
shares one footer, rather than inventing separate per-prompt durations. Idle time between runs is excluded.
The completion timestamp is formatted in the attached UI's local timezone. Failure, cancellation and
unconfirmed outcomes use `Failed after`, `Cancelled after` and `Stopped after`, never `Worked for`.
The footer is decorative and is not included in source selection or raw answer copying.

The existing SDK writer saves versioned completion metadata as a context-neutral custom entry, so
reopening, reconnecting and read-only History retain it without changing model messages. Older records
without metadata show no invented duration/date. An optional timing-save failure keeps the accepted run
outcome and adds an explicit persistence warning, not a rollback or failed prompt. The additive
`run-completion` capability requires an upgraded service for new timings; no running service is
restarted automatically.

The shared OpenTUI clipboard service uses best-available host/terminal delivery. A host write is
reported as copied; OSC52 is reported only as a request sent to the terminal. Unsupported delivery
and failures are explicit and retain the selection. Acceptance by a real SSH terminal or multiplexer
is not inferred from dispatch. Reading/copying does not send prompts or change saved SDK history.

Only navigation state is stored in the additive `agentViews` preference; it survives switching
sessions/views and reconnecting to the same live runtime. Stable live section IDs do not promise
restoration of temporary selections after a service restart. Full transcript text is not limited to
the legacy 12-message/12,000-character preview; the existing **8 MiB IPC frame limit** still applies,
and transcript paging is not implemented. Older services remain usable with a clearly marked legacy
preview. Finish their jobs and explicitly stop/restart them to load the new capability; no service
is automatically restarted.

### Agent input status

A passive row above and outside the prompt box shows the selected model, effort and current `fast`
setting, followed by **context remaining** and **account usage**. Both meters use the same block-bar
style. A provider icon identifies the account meter; `18% used 1h 20m` means consumption followed by
time until reset, without a middle-dot separator. Reset times use `5d 23h`, `1h 20m` or `18m`. The compact meter selects the longest returned
quota window; all returned windows remain available in the IPC snapshot. There is no refresh button.

Filled bar cells fade from the terminal's accent toward the panel color; empty cells stay subdued.
Context labels and known values use the same foreground as account usage. Model names use the theme's
number (yellow/gold) color, effort uses keyword, and `fast` uses success when on or info when off; unknown values
and separators stay muted. These are terminal palette roles, not fixed product colors.
The prompt surface reaches both edges of the Agent pane; its internal padding aligns the editable
text with the transcript mode and telemetry rows. The sidebar divider sits at the right edge of its
character cell, avoiding a half-cell gap beside the prompt surface. The empty prompt has no marker or placeholder,
and focusing it keeps the same surface background; the caret and left border indicate focus.
Normal screens leave one blank row between the mode, telemetry and prompt rows. Screens shorter
than 18 rows remove both gaps together. Narrow panels shorten bars and omit settings or the
countdown before dropping either resource percentage. Theme changes preserve the current draft and focus.

Provider logos reserve two columns. On terminals reporting Kitty/Sixel graphics and pixel resolution,
OpenTUI renders a font-derived, theme-tinted image with approximately 1.5x the ordinary glyph width,
within the same row. Other terminals retain a bold Nerd Font glyph; individual character scaling is
not assumed. No terminal font settings are changed. Asset attribution is in
`src/ui/provider-icon-data.LICENSE`.

Context comes from Pi's estimated usage and model limit. After compaction it can be unknown until
the next response. Radian supplies `/fast [on|off|status]` for OpenAI Responses/Codex models, including
prompt completion. Its per-model, per-session state starts **off**, so a restored session does not
remain unknown merely because it has not sent a request. `/fast on` opts into `service_tier: priority`;
`/fast off` removes an explicit priority/fast tier. These commands themselves never invoke a model or
add conversation messages. They do not change effort, write global configuration, or persist priority
across a runtime restart. Priority can increase usage and is not a guarantee of server speed.

An existing extension registering `/fast` replaces the default control; its request observers remain
intact. Such an extension may leave the initial state unknown until its first outgoing request.
Older services without a registered `/fast` command reject it from the new client rather than treating
it as a paid model prompt. Finish existing jobs and explicitly restart the runtime to load this control.
Displaying usage, context or `fast` state never enables priority by itself.

Account usage has a provider-neutral model and runtime monitor under `src/usage/`; provider-specific
authentication and HTTP stay in `src/usage/providers/`. The initial source supports **OpenAI/Codex
subscription OAuth only**, reusing Pi's resolved login. OpenAI API keys and other providers report
unavailable until a matching source is implemented. No third-party extension or Codex CLI is required.
The source uses the undocumented ChatGPT `backend-api/wham/usage` endpoint also used by Codex, so its
format and availability are not guaranteed. Usage lookup itself is read-only and sends no model prompt.

A session starts its first lookup without waiting for a prompt. Reconnection, provider selection and
final `agent_settled` events request fresh usage; short bursts and simultaneous sessions share work.
While any TUI is attached, the runtime polls every 60 seconds and at returned reset deadlines. Account
identity is checked during each lookup; external login changes are picked up on the next lookup.
The cache is shared by matching accounts within one workspace runtime, not across separate runtimes.
Detaching all TUIs stops periodic polling. Shutdown aborts lookups and invalidates late responses.

The countdown is calculated locally and ticks every minute or at its reset deadline, without HTTP requests.
Resetting a window triggers another lookup, never an invented 0%/100%. Missing, unsupported or failed
usage shows the provider icon and **-**, without a bar or fake countdown; typed failure codes remain in
the snapshot for diagnostics. Credentials and private account/cache identifiers are never sent to the
TUI or saved in its preferences. Restoring history always uses live usage rather than saved quotas.
Earlier telemetry snapshots with only `weekly` remain readable and are converted to `used` for display.
Finish existing jobs before explicitly restarting an old runtime to load the new usage source.

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
PgUp/PgDn scroll. Refresh is keyboard-only; its shared spinner stays vertically centered beside
the tabs in a reserved cell, with the same minimum-visible policy and no toolbar layout shift. Diff j/k scrolls both columns vertically, and h/l or left/right arrows scroll them horizontally. History is bounded to
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
Tab labels show the foreground executable (for example `zsh`, `nvim` or `bun`), not `Terminal N`.
The TUI reads a bounded local process snapshot while Terminal is visible, checks each shell's
supervisor parent, and selects its actual terminal foreground group rather than a background job.
Only executable names are read, never command arguments. Queries are cancelled when hidden;
renaming keeps existing tab/terminal instances and focus. Existing runtime PID metadata is enough,
so this needs no service restart. If inspection fails, a notice explains that terminal input is
unaffected and the known shell/last process label remains available.

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
narrower than 80 columns. Main work tabs leave a single blank row before their content; screens
shorter than 18 rows omit that gap. Work surfaces have no additional top or bottom panel inset. Routine Neovim/worktree captions, the `Git · … · All refs` line and the terminal
`… · running` line are omitted; empty, error, exit and reconnect messages remain meaningful.
Agent input, Editor, Git lists/diffs and Terminal end at the same bottom edge as the sidebar
divider, without an unused row below them. The sidebar widens to retain
room for its tree. Embedded programs receive the measured inner viewport rather than rendering
beneath the padding. The footer text remains one row, with its gradient extending through the
product text's inset to the screen's left edge.
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
`1`/`2`/`3`/`4` to select Agents/Editor/Git/Terminal, `b` to toggle the sidebar,
`w` to reveal/focus the sidebar or `f` to reveal/focus search.
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
    "session.new": [{ "keys": "s", "scope": "session-tabs" }]
  }
}
```

Spaces separate sequential keys (`"space r"` is a two-key leader); `+` combines modifiers.
Use explicit `shift+c` for uppercase C. A string binding is global; an object can specify `scope`:
`global`, `app` (outside PTYs), `pty`, `workspace`, `search`, `history`, `history-search`, `session-tabs`, `prompt`, `prompt-completion`, `button`,
`transcript` (section navigation), `transcript-text`, `transcript-visual`, `editor`, `terminal`,
`git`, `git-prompt`, or `none`. An override replaces that command's defaults;
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

The left navigation and right work panel share one full-width footer. Its single text row places
`Radian` and its version on the left and shortcuts for the **currently focused control** on the right.
The footer occupies exactly one terminal row at every screen height, with no decorative row above it.
Errors and notices remain separate above it. A subtle background gradient starts at the screen's left
edge, including the product text's inset, and fades
the terminal's accent into the footer surface toward the right. It follows palette changes and optional theme overrides. Keys are highlighted separately
from their descriptions. Tree, search, History, buttons and prompt contexts update on actual focus/state changes; unrelated/global shortcuts are not appended.
Application bindings such as `Ctrl+f`, `Ctrl+e` and `Tab` still work outside Neovim input focus;
the configured leader detach command works in every input context. See the input ownership rules above.

The status-icon legend and routine live-service banner are not shown. Errors and service notices
appear in a separate row immediately above the footer only when nonempty, so they never replace
shortcut hints. Clearing a notice returns its row to the work panels.
The footer itself is read-only: clicking it neither runs an action nor takes input focus.

The footer text stays one line on narrow terminals. Identity stays on the left; complete shortcut/label
pairs fit in the owner's supplied order and trailing pairs are omitted with an ellipsis. Resize
restores them when space permits. The footer does not invent Help actions or priority categories;
a control may supply its own contextual help shortcut. Active completion uses the configurable
`completion.next`, `completion.previous`, `completion.accept` and `completion.dismiss` commands.
Default Tab focus traversal excludes `prompt-completion`; overriding Tab globally requires rebinding
or disabling the conflicting completion acceptance binding. Input editing, Ctrl+F/E focus shortcuts,
and Neovim/shell input ownership are otherwise unchanged.
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
resources. Configured Pi extensions, context files, skills and prompt templates use SDK discovery.
Pi's interactive terminal UI is not embedded; extension-specific UI compatibility and subprocess
cleanup depend on the extension's SDK integration. Cache warming is disabled.

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

These administrative commands target only the repository containing the launching directory,
regardless of configured workspace roots, and do not start a missing service. `--stop-runtime` retains
open-session intent and saved history; it is different from closing a session, which removes that open item.

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

The Agent view uses the structured read-only transcript described above on services advertising
`agent-transcript`; the bounded recent `output` field remains for compatibility with older clients.
Full SDK history remains in JSONL. Configured Pi extensions, including MCP adapters, use SDK discovery;
this does not embed Pi's interactive CLI UI or provide remote-machine services.

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

History is a searchable popup, not a sidebar tab. Use **History** beside the Agents session controls,
or **Ctrl+Space → h** (`history.show`) from any work view. Its scope is the active worktree, not the
sidebar navigation cursor. The list uses SDK conversation names (falling back to the first prompt or
`Untitled session`), last activity and message count, newest first, including in shared offline directories.

Type a fuzzy title query, including Unicode text. Arrows or Ctrl+N/P move the candidate cursor without
changing the live session; normal letters, including hjkl and r, remain search text. `Tab`/`Shift+Tab`
cycle within the popup. The list additionally supports j/k and Home/End. `Enter` opens the selected
context in Agents, or selects its existing open tab, without copying/forking the SDK file or sending a
prompt. Clicking a row only selects its preview. `Esc` closes the popup and restores its original
focus without changing drafts, transcript scroll, work views, sidebar visibility or PTY attachments.
Global view/sidebar/session commands are inactive while the popup owns focus. Closing a popup while
Open is pending does not cancel or roll back an accepted request; a late result never changes selection.

Wide screens show the list and read-only conversation preview side by side. Below 100 columns,
Ctrl+O switches between them; PageUp/PageDown scroll the preview. Preview reuses the Agent transcript
component, including compact inline invocations, Markdown prose, error styling and initially folded
tool sections; Thinking remains visible just as in the live transcript.
It shows at most the three newest sections of the saved current branch, in chronological order.
A new unanswered prompt is not filled with the previous turn's replies; explicit skills remain name-only. This does not open a writable SDK session, load extensions or execute tools. Selection changes debounce preview requests for 150 ms;
superseded/hidden queries are cancelled and stale responses ignored. The reader verifies the session
header, then scans JSONL record offsets backwards in 64 KiB chunks and follows the active branch's
parent IDs. It stops once the recent window and required tool-call associations are available, rather
than loading or size-rejecting the entire file. Older unneeded record bodies are not decoded or validated;
opening a closed session still validates the complete history. Safety limits apply to individual records (16 MiB),
the retained association working set (32 MiB), header size (64 KiB) and lookup time (5 seconds), not
total file size. Each returned section body is capped at 8,192 UTF-16
units with an explicit truncation notice; the compatibility text field remains capped at 65,536 units. The title query searches all returned metadata locally; at most 200
matching rows render at once, with a prompt to refine larger result sets. Full-message search is not
implemented. Ctrl+R refreshes metadata (`r` also works while the list has focus). Shared loading spinners
remain visible for at least 500 ms without delaying results or errors, and cancel on close/disposal.
Empty history, no matches, discovery failures, preview failures and Open failures remain distinct.

Closing records and active owned-child writers cannot be opened until cleanup finishes. Completed
SDK child conversations can appear in history; there is no new deletion, retention or main-only filter.
The sidebar search remains exclusively the workspace-name projection. A worktree change closes an
open popup rather than admitting an outdated selection into the new scope.

The additive `history-preview` capability uses an instance-fenced read-only GET endpoint. Older
services keep their running jobs and are **not** restarted automatically: title search and Open remain
available when `history` is supported, while preview explains that an explicit service restart is
needed after saving/finishing work. Services without `history` report that missing capability.

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
Repository-name matches retain all worktrees; folder/branch matches retain the matching worktree
and its parent repository. Session tabs stay with the active Agents view and are not part of the tree
projection. Session/subagent titles, paths, status text and history are not searched.

Press `Esc` in the search field to clear the query and restore the complete tree. Press `Enter`
to focus the workspace results. No matches shows a sidebar message, not a new central empty
session state. Filtering changes only the displayed tree: the current worktree/session selection
and source snapshots stay intact, even when selected items are hidden. Keyboard tree navigation
uses the visible results, and host snapshot changes are re-filtered with the current query.
No Git commands or runtime operations are triggered by search input.

### Display status

Repository and worktree rows retain their Nerd Font type icons. Worktrees show a compact
working/failure summary so background activity remains visible without nested agent rows.
Session tabs aggregate the main agent and subagents: any failure wins, otherwise any working
agent keeps the session working, and completion requires every agent to have completed.
Working uses the shared animated spinner; final outcomes appear immediately in a fixed-width
badge, independently of the spinner's minimum-visible tail. Hidden views cancel their animations.
Selection and focus do not change execution status.

The transcript mode/Input row shows the selected session's subagent counts at its right edge.
Working, failure, complete and unknown counts use reserved widths; narrow panels omit less urgent
counts or shorten the prefix without adding rows. Counts only include runtime-owned children
already supplied by the snapshot, not arbitrary extension-managed processes. The row's `paused`
means transcript auto-follow is paused, not agent execution. Model/context/account usage remains
on the separate telemetry row.

The SDK adapter normalizes events into display snapshots. `agent_end` alone is not completion:
automatic retries keep the run working, and `agent_settled` plus the final outcome determine
completion/failure. Aborted or unreported outcomes use a neutral dash, never successful completion
or a guessed idle/waiting state. Additional idle/waiting/cancelled icon policies are not defined here.

Use a Nerd Font-enabled terminal to view the glyphs. Current mappings are `nf-cod-repo`
(U+EA62), `nf-cod-folder` (U+EA83), `nf-cod-check` (U+EAB2), `nf-cod-close` (U+EA76),
`nf-cod-dash` (U+EAD9), `nf-cod-openai` (U+EC81), and
`nf-cod-claude` (U+EC82), from Nerd Fonts 3.5.1. Headless tests
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
| `src/agents/ui/` | Session tabs/status, Agent transcript/prompt/drafts/scroll and saved-History panel |
| `src/usage/` | Provider-neutral account usage snapshots, shared polling/cache and isolated provider sources |
| `src/editor/` | Worktree Neovim lifecycle and its UI panel |
| `src/terminal/` | Shell-tab lifecycle, ownership supervisor/cleanup and its UI panel |
| `src/git/` | Read-only Git queries, comparisons and Agent context; Git-specific rendering lives in `ui/` |
| `src/workspace/` | Repository/worktree discovery, snapshot models and search projection |
| `src/runtime/` | Detached service, IPC, recovery, checkpoints and shared `pty/` implementation |
| `src/keybindings/` | Application commands, binding configuration and input routing |
| `src/ui/` | Shared footer, loading feedback, clipboard, theme and embedded-terminal presentation |
| `src/testing/` | Isolated repositories, scripted SDK responses and test helpers |

`src/index.ts` is the executable entry point. `app/bootstrap.ts` wires the runtime and feature
interfaces; features do not import the workbench. Keep feature runtime modules independent of their
`ui/` subdirectories: co-location does not mean they execute in the same process. Do not add barrel
exports that load OpenTUI when the daemon imports Agent, Editor or Terminal lifecycle code.
Workspace models remain outside `app`; the workbench owns tree rows and navigation presentation.
The existing repository/worktree snapshot still includes Agent summaries for compatibility, not
execution ownership. Wire schemas and checkpoint contracts remain owned by `runtime/protocol.ts`; transcript sections
and navigation preferences extend those contracts with optional fields.

Tests live beside their feature or integration owner. Whole-workbench tests are under `app/ui/`;
feature interaction tests may compose the real workbench. Pure file moves do not change renderable
IDs, key commands, runtime namespaces or saved-session identifiers. View-controller separation and
further model/transport decoupling are follow-up work, not implied by the folder names.

## Repository

https://github.com/oneable-dev/radian

## License

This project is licensed under the [MIT License](LICENSE).
