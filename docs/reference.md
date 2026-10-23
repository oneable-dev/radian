# Radian reference

[Back to README](../README.md)

Detailed behavior and implementation notes, preserved from the original README.
Source paths in prose and commands are relative to the repository root.

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
and `~/.dotfiles`). Workspace navigation is a centered, searchable **popup**, not a permanent sidebar.
Open it with **Ctrl+f** outside embedded programs, or **Ctrl+Space, then w/f/b** from any work view.
It contains repositories and worktrees only, without a preview pane. Folder and branch occupy two
aligned lines in one selectable item and share horizontal scrolling. Metadata updates preserve the
query, cursor and scroll position. Failures have a fixed error slot; navigation does not animate.
Use **Ctrl+N/P** in either search or results; Tab into results for **j/k** and Home/End.
Arrow navigation remains available by default and is omitted from shortcut hints and help.
**Enter** opens the highlighted worktree and restores its last work view/session; a worktree click
also opens it. **Esc** closes without changing selection and restores the original focus.
Opening or closing the popup never changes the work pane or PTY dimensions.
**Ctrl+Space, then s** opens a separate session monitor with a History-style live preview.
Neither popup adds a top-level entry button or a global notification counter.
Open sessions remain tabs within Agents; focus that strip to use `h/l` (or left/right),
Home/End, `n` for new and `x` for close.
The session prompt owns input by default; `Enter` submits, `Shift+Enter` or `Alt+Enter` inserts a newline,
and `Ctrl+C` clears the draft without interrupting work. `Esc` interrupts the selected Agent;
when messages are waiting, it interrupts and submits them together immediately.
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
not automatically replay a prompt. Pending messages appear between the work-status row and prompt,
with no queue count. They are removed only when actually delivered. One bullet-led heading combines
`Messages will be sent after the current response and tools finish` with the muted hint
`(press esc to interrupt and send immediately)`, with only the key in bold. Each queued message is
indented beneath it with `↳`, followed by one blank row before the prompt when height permits.
Narrow panes shorten the heading and hint in place instead of adding a separate help row.
Pressing **esc** interrupts the selected session, waits for its active operation and tools to settle,
then joins all pending messages with newlines and sends them as one message, retaining image blocks.
Unsent drafts are never included. Without pending messages, **esc** only stops the current operation,
including manual compaction; it does not close the session, affect other tabs, or roll back file changes.
An open completion menu consumes the first Esc to dismiss itself. Ctrl+C clears only the current
prompt draft and its attachments. No separate follow-up mode UI is added.
These controls require the additive `agent-interrupt` service capability. An older service rejects
interruption explicitly and is never automatically restarted.

`--demo` remains display-only: closing removes fixture metadata and creation only reports a
request. It does not invoke Pi, access credentials, or create stored sessions.
The History popup lists saved SDK conversations for the selected worktree and opens them explicitly.
The Agent view provides a keyboard-first, read-only transcript and prompt, not a conversation-content editor.
The Editor view embeds Neovim; Git provides a native, read-only history and whole-file diff UI.

### Command-line interface

Commander handles options, help, version and shared-daemon lifecycle commands:

```sh
bun run start --help
bun run start --version
bun run start --demo
bun run start --no-color
bun run start runtime status
bun run start runtime stop
bun run start runtime restart
bun run restart # Same daemon restart; reopen the TUI with dev/start if needed
```

Help/version and invalid arguments are handled before SDK/resource initialization, configuration
reads, workspace discovery or service activation. Interactive mode requires TTY stdin/stdout and a
cursor-addressable UTF-8 terminal; pipes and `TERM=dumb` receive plain guidance instead of fullscreen
escape sequences. Runtime commands remain usable without a TTY and ignore workspace-root discovery.
`runtime stop` explicitly closes the shared daemon and its agents, editors and shells across **all**
owned repositories. `runtime restart` then starts a fresh daemon without replaying interrupted work;
save work and editor buffers first. The existing `--runtime-status` and `--stop-runtime` aliases remain accepted.
Internal service flags and isolated `--test-runtime` startup remain compatible.

`--no-color` or a nonempty `NO_COLOR` uses terminal-default foreground/background with existing
bold/underline and reverse selection emphasis. It does not merely replace colors with gray RGB
escapes. Provider icons use the text fallback and branding omits its color fade. Embedded programs'
configuration remains untouched; only the attached UI's final frame is rendered without color.
The normal colored UI continues to follow the host palette. Ordinary runtime commands select the
shared daemon by state directory and live/test mode, not `cwd`. `--runtime-cwd` chooses the initial
repository or the target of an explicit `--legacy` command; a relative `--state-dir` is resolved once
against the launching directory.
`--config PATH` selects unified settings. `--workspace-config`, `--keybindings` and `--theme` remain
compatible per-section overrides.

### Unified settings

User settings live in `${XDG_CONFIG_HOME:-~/.config}/radian/settings.json`. The file is optional;
`--config PATH` selects another file and resolves its path once against the launching directory.
For example:

```json
{
  "theme": { "accent": "#7DD3FC" },
  "keybindings": { "leader": "ctrl+space", "timeoutMs": 1000 },
  "workspace": { "roots": ["~/projects"], "maxDepth": 4 },
  "sessions": { "retentionDays": 30 }
}
```

Each section uses its existing domain validator. Precedence is: an explicit per-section CLI file,
that section in unified settings, its optional legacy file (`theme.json`, `keybindings.json`, or
`workspace.json`), then built-in defaults. A present unified section replaces that legacy section;
missing sections still honor existing files. Legacy files are not rewritten or deleted. Relative
workspace roots resolve against the file that defines them. Unknown sections and invalid values
are errors; an explicitly selected settings file must exist.

Reopen the TUI to apply theme, keybinding and workspace edits; this does not stop running jobs.
The daemon reads session retention at startup and every hour, so edits to its selected policy file
apply at the next sweep. Each repository registration retains its selected policy-file path across
shared-daemon restarts. A conflicting `--config` is rejected rather than silently changing another
client's cleanup policy; use the registered file or a separate `--state-dir` for an independent policy.
A malformed or previously observed but now missing policy file pauses cleanup with a notice; it
never silently switches to a destructive default. Help, version and administrative runtime commands
remain independent of user configuration. Pi authentication/model settings and persisted session
snapshots remain separate from this Radian user-settings file. There is no settings UI yet.

### Workspace roots

Normal mode scans `~/projects` and `~/.dotfiles`, including a root that is itself a repository.
Set the `workspace` section in unified settings. The legacy
`${XDG_CONFIG_HOME:-~/.config}/radian/workspace.json` and explicit `--workspace-config PATH` remain
supported with this section's contents:

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

Worktrees within discovered repositories update automatically. Native filesystem watches observe
Git's canonical common directory and linked-worktree registration metadata, including the first
creation or replacement of the `worktrees` directory. Events are debounced for 250 ms, then Git's
worktree list is reread; there is no periodic workspace scan or polling loop. The shared daemon
owns a catalog watcher for every registered repository, including cold repositories with no SDK,
Editor or Terminal resources. Watching continues after the TUI detaches. Agent sessions, History, Editor and Terminal share the updated
catalog. Existing sessions, drafts and selection survive refresh; removed worktrees with open
resources remain listed until those resources are released. Failed scans retain the last valid
list and expose a notice. Services that were started before this feature was installed need a
one-time restart to load it; reopening only the TUI does not replace an existing service.

The TUI registers discovered repositories with **one shared Bun daemon per user/state-root/mode**.
Repository execution resources initialize only when selected or explicitly used; registration does
not create an Agent, editor or shell. The launching repository is preferred initially when present,
otherwise the first discovered repo. Repository-scoped channels retain their own instance fencing,
PTY leases, catalogs, preferences and persistence; these channels do not spawn additional Bun services.
Drafts, selected sessions and view state survive lazy activation; detaching releases this TUI's
connections, not the underlying agents or native processes. Existing legacy repository processes are
attached without being stopped or overwritten and show a migration notice (see Service lifetime).

### Work views

Workspace navigation is an overlay; the work pane always uses the full available width.
The work pane switches between **Agents**, **Editor**, **Git** and **Terminal**, with one visible
view per worktree and Agents as the initial view. There is no top-level view tab strip:
**Ctrl+Space, then a/e/g/t** selects the view and focuses its work area. The footer identifies the
current view next to the Radian product name, independently of keyboard focus.
**Ctrl+Space, then 1–9** selects the corresponding Agent session or terminal in the current worktree's
tab order. Missing slots and numeric selection in Editor/Git do nothing; no sessions are created.
**Ctrl+Space, then n** creates an Agent session or terminal in the current view, including when
no tabs remain. It does nothing in Editor/Git. In Agents, the new session is selected and its prompt
receives focus once it appears. If you navigate elsewhere while creation is pending, the new tab opens in the background
without taking focus. Agent and Terminal session strips remain visible and clickable.
Tree cursor movement is only navigation; Enter or a direct worktree click commits the selection.
Each worktree separately remembers its work view and selected Agent session. Within Agents, session
tabs use the full session UUID as their label, alongside aggregate status and a close control.
Agent and Terminal tabs share an 18-cell frame, including padding and the right-aligned `×` control.
Each tab has a left-only accent border and a separate, one-based position number (`1.`, `2.`, …) before its status and title.
Both strips use the same accent color, brighter on the active tab and subdued on inactive tabs.
Numbers follow each strip's current order, including positions above nine, and are updated when tabs close or reorder.
Title truncation preserves the number; at widths too small for both the number and close control, the close control takes priority.
Status changes and process renames do not move neighboring tabs or their close controls. If the pane
is narrower than one tab, the frame shrinks to fit and truncates its label with `…`.
UUID labels use all available title space and truncate only at the end with `…` when necessary;
IDs that fit are shown in full. There is no eight-character prefix limit or special collision-based
formatting. Selection, closing and persistence still use the full UUID, even when truncated labels
look identical. Session names remain unchanged for History and other metadata. Use the same configured `tab.new` sequence from input, the tab strip or the empty body;
the strip remains focusable when empty. `Ctrl+N/P` navigates tabs, not session creation.
The upper-right worktree label and the New session/History toolbar buttons are removed. Session-tab selection and History resume open the chosen session in Agents. Restoring a
selection, filtering and background snapshots never implicitly activate another work view.
Session creation/closing retain their existing rules and never implicitly launch an editor.
With no open Agent sessions or terminals, a shared centered empty state shows a muted icon, a short
`No AI sessions` / `No terminals` title and the actual configured creation shortcut. Disabled bindings
have no fabricated default hint. Small bodies prioritize the shortcut over decorative artwork.
An existing Agent session with no messages still shows its separate Radian logo and prompt.

**Ctrl+Space, then b** toggles the workspace popup, initially closed, and focuses its search input.
The existing `sidebar.toggle`, `focus.sidebar` and `focus.search` configuration IDs remain accepted.
Search state survives closing and reopening. Tab traversal is trapped inside an open popup; hidden
navigation controls are excluded from normal traversal. Cancelling restores the original Agent,
Editor, Git or Terminal focus. Selecting a workspace closes the popup and focuses its restored view.
Agent/Editor/Terminal instances, drafts, transcript positions and History rows remain intact.
An overlay never resizes Neovim or shells, even if the native process is temporarily suspended.
Physical terminal resizing still uses the existing PTY snapshot safeguards; no service is restarted.

Every worktree remembers its active tab. Agent retains its selected session, draft, transcript
scroll position and section/cursor/folding state; Neovim retains its actual files, cursor, editing mode and unsaved buffers in the
detached runtime. Terminal retains its shell list, selected shell and log viewport. All four views
restore on TUI reconnect while that runtime remains alive.
Git restores its ref filter, selected commit/file, comparison and scroll positions into the Commits
main view. Refs/Reflog modals and their search queries are transient; legacy tab fields remain readable
but do not reopen a removed tab or popup.
Only view identities/positions are stored in the additive `gitViews` preference, not file contents
or requests to replay. Git data is read again on a fresh TUI attachment. Demo mode remains display-only.
See **Native Git** below for the supported operations and resource limits.

Editor uses the entire work pane with no application-owned padding on any edge; only the shared
footer (and any actual notice row) remains outside it. Neovim receives that full viewport size on
both explicit launch and resize. Neovim's own UI configuration is unchanged.

Select Editor to explicitly open/attach Neovim. Worktree navigation and reconnect attach an existing
editor without restarting it. If no process remains after runtime restart, the view offers an explicit
open action instead of silently replacing lost editing state. `:q`/`:qa` remain Neovim's commands;
when Neovim exits the Editor view stays selected and offers an explicit reopen action.
Within one TUI, each editor's native surface retains its last screen while hidden. Returning to an
existing editor immediately displays that screen instead of recreating a blank VT. Its old attachment
is still detached, and input stays disabled until a fresh exclusive attachment is acknowledged.
Selecting an already connected Editor focuses it without opening or reconnecting again.

While the embedded terminal is focused, Neovim receives Tab, Esc, Ctrl+f/e, mouse and paste.
**Ctrl+]** opens the workspace popup; outside the editor, existing application focus keys
and Tab/Shift+Tab traversal work. **Ctrl+C is native input**, not an application detach binding.
Use the configured detach sequence (default **Ctrl+Space, then c**). The footer follows the actual
focused control and effective keymap. Opening, switching and resizing do not
send a prompt to an agent or run a Git mutation. Entering Git may perform read-only queries.

### Multiline input and attachments

Agent input has no 1,000-character editor limit. **Enter** sends; **Shift+Enter** inserts a newline.
**Alt+Enter** is an alternative for terminals that cannot distinguish Shift+Enter. Editing grows the
input to at most six visible rows, bounded by available screen space, then scrolls inside the editor.
Pasting never sends automatically and preserves original newlines. Clicking anywhere on the input
surface, including its padding and border, focuses the editor without changing the draft or cursor;
clicking directly on text still uses native cursor positioning.

Long pasted text (at least 1,024 UTF-16 units or nine lines) appears as
`[Pasted Content 6324 chars]`. Control-containing text also collapses rather than painting control
sequences; its original data is retained. Images appear as `[Image #1]`, files as `[File #1]`.
These are atomic editor items, not text sent in place of the source. Arrow movement, deletion,
undo/redo, session switching and saved drafts preserve their source data. Literal typed labels
without attachment metadata remain ordinary text. **Ctrl+O** at an item opens read-only source
information. Use **y** to copy and **Esc** to return to the input; remove an item with ordinary
input deletion such as Backspace, not from the details popup. Pasted text shows its original
contents; image/file items show their source references, not rendered image thumbnails.

Paste absolute/`~/`/`./`/`../` paths, quoted or escaped file drops, or local `file://` URLs to attach
files. File completion inserts the same numbered items. File parts become explicit absolute path
references for the SDK's tools; Radian does not silently upload arbitrary file contents.
**Ctrl+V** reads supported images, file URLs or text from the host clipboard, including while command
or file completion suggestions are open. Use Ctrl+V for clipboard images; terminal paste shortcuts
(such as macOS Cmd+V) do not invoke this host read. Remote host clipboard reads are rejected
explicitly; terminal paste remains available for text and paths. Clipboard-read progress uses an
absolute spinner in the composer's existing right gutter; its loading/minimum-display tail never
adds a status row or changes the transcript viewport. Hiding the composer cancels it immediately.
Clipboard images are stored under `${XDG_CACHE_HOME:-~/.cache}/radian/attachments` using private
directories and files, so saved drafts can retain them. These owned cache files are not automatically
pruned while other clients or undo history may still reference them.

Image bytes are decoded/normalized with the installed Pi SDK and sent as real image content blocks.
Unsupported models, invalid images and older services reject before admission and retain the input;
no service is automatically restarted. The additive `prompt-images` capability gates this transport.
The runtime limits aggregate source image bytes to 16 MiB and command payloads to 8 MiB for resource
safety. Aggregate workspace state has a separate receive budget described below. Exceeding a boundary
rejects the whole operation; it never silently truncates input.
Rich input drafts are additive preference metadata, alongside compatible original-text/path drafts.
A legacy client's replacement text invalidates stale attachment metadata instead of resurrecting it.
Git's Ask Agent input uses the same multiline, paste and attachment rules.

### Prompt completion

The Agent prompt shows a read-only completion menu directly below the input. `/` opens command
suggestions only in the first token at the beginning of the prompt. `$` opens a separate Skill menu
in that same leading position; Skills do not appear in `/` suggestions. `@` opens file suggestions at
the beginning of any whitespace-delimited token, including in the middle of a sentence; email
addresses do not trigger it. Matching uses the text before the cursor, not just the end of the draft.
Commands, templates and Skills require a contiguous name prefix; file paths accept a contiguous
substring and rank prefix matches first. Matching is Unicode-normalized and case-insensitive,
without changing inserted names or paths. Spaces inside a quoted file query remain literal.

Already-connected SDK sessions prefetch a full command/Skill catalog, not a 100-item search page.
File indexes are shared by worktree within the attached UI and prepared in the background. Cold
repository services are not started for completion. Once prepared, typing searches memory immediately:
there is no per-keystroke IPC, Git query, 150 ms debounce, or newly started loading indicator.
Only initial preparation or an explicit resource refresh can show loading. Legacy asynchronous
completion providers retain their 150 ms trailing debounce. Catalogs stay cached until `/reload`,
a new conversation, a replacement runtime, or connection recovery; ordinary streaming snapshots do
not reload them.

The closed menu reserves no space. When open, its height follows the visible results:
up to five candidate rows, plus a compact position counter below them when the list overflows or is
truncated. Initial loading, errors and no matches use just one row. Candidate names and descriptions
share aligned columns; an arrow and accent text mark the selection without a background fill.
Narrow panes prioritize candidate names. During refresh the previous candidates and selection stay
visible until fresh results arrive, then the menu expands or shrinks to fit. Stale candidates cannot be
inserted until results for the current query arrive. Footer shortcuts retain their positions and
unavailable actions use muted keys instead of disappearing.

- **Ctrl+N / Ctrl+P** selects the next/previous candidate. `hjkl` remains ordinary input.
  Dismissing the menu restores ordinary cursor movement.
- **Tab** inserts the selected candidate without sending the prompt or executing a command.
- **Enter** completes the focused command, template or Skill candidate and immediately submits it
  in one key press: `/com` with `/compact` focused runs `/compact`, not `/com`; `$rev` with
  `review-code` focused invokes that Skill. Existing arguments are preserved, and immediate execution
  adds no trailing completion space. If a focused command is
  being refreshed, Enter waits for fresh results; editing, dismissing, switching sessions or a changed
  selection cancels that pending submission rather than executing stale or incomplete input.
- With no focused command candidate, **Enter** submits the current input as written. File suggestions
  still require **Tab** for insertion. **Esc** dismisses only the menu and preserves focus/text.
- Selection replaces only the current token, preserving the surrounding text and native Unicode cursor.
  Selected files appear as numbered file/image items rather than exposing long paths in the editor.
  Ordinary file references retain their absolute paths for tool access; images use the image transport.

Command candidates come from the selected SDK session's registered extension commands and prompt
templates, together with Radian's host commands. Enabled Skills are exposed only through `$` discovery.
A leading `$skill-name instructions` invokes the loaded Skill through Pi's existing `/skill:skill-name`
expansion. An unknown standard `$skill-name` invocation is rejected before a model request; manually
entered `/skill:name` still works. Inline or multiple `$` Skill references are not supported. Inline text
and shell forms such as `$HOME`, `${HOME}` and `$(pwd)` stay literal unless the token names a loaded
Skill. `/model` opens Radian's native model picker; Pi CLI-only commands such as `/settings` are not
advertised as implemented.
Pi's interactive dialogs/custom terminal components are not embedded.
Extension-initiated session replacement, tree navigation and reload still fail explicitly instead of
bypassing Radian's ownership; use the host session commands. Commands can wait for the current run
to become idle. A handled command without a model turn preserves the previous status. Command failures retain the draft and report an uncertain action
outcome because an extension may already have changed state; do not blindly retry.

File discovery lists existing tracked and nonignored untracked file paths in the selected session's
worktree. It does not search other worktrees or read file contents. Search results contain at most
100 candidates and indicate when further filtering is needed; this does not truncate the stored index.
Recursive filesystem watching is installed before the initial scan. File additions, removals, renames,
and moves invalidate the index; directory changes include all descendants. Notifications are coalesced
for 200 ms, then reconciled with Git rather than trusted as an exact add/delete log. Ordinary content
edits do not rebuild the path index. Ignore rules, Git index/config and global excludes changes also
trigger reconciliation. Watcher errors are explicit and receive one bounded automatic reconnect/rescan;
`/reload` can retry again. Failed scans retain the last good index internally, but are not presented as
fresh successful searches. Git listing remains bounded to 5 seconds and 4 MiB.

Dismissing a menu cancels that query, not the shared initialization or file watch. Session/conversation
and runtime identities fence late catalogs; command/Skill submissions also fence resource revisions.
Closing sessions releases unused indexes; detaching the UI closes its watchers and cancels
initialization. Lookup is read-only and never starts a model turn.
The additive `completion-catalog` capability requires an updated runtime for cached `/` and `$` menus.
Finish existing work and explicitly restart an old service to load it; no service is restarted automatically.

### Agent transcript

An upgraded runtime supplies separate **You**, **Agent**, **Thinking** and **tool execution** sections.
Tool calls and results are joined by call ID, not tool name; unknown tools and MCP bridges use the
same generic interactions. MCP-specific transcript actions are not included.
Tool details and `Context compacted` summaries start folded; user/Agent text starts expanded.
Click a compaction summary's heading or use the configured fold key (`Ctrl+o` or `z a` by default)
to expand/collapse it. Explicit fold choices are preserved in transcript view preferences.
Thinking is always visible prose with no label or fold controls; old Thinking fold preferences
are ignored and cleared. Other nonempty sections can be folded manually. Error summaries stay visible outside the folded body, and folding never deletes text.
User image attachments have independent, initially folded `[read] filename.png` sections. Click the
header or use the configured fold key (default `Ctrl+o` / `z a`) to toggle a proportional inline preview.
The header is presentation only; it never executes the read tool. Editor-only image labels are removed
from the displayed prose, without changing SDK messages or model input. Original filenames are saved
as display-only metadata; unnamed/older attachments use names such as `clipboard-1.png`.

Pixels are requested only when expanded, using a session-scoped, instance-fenced image identity rather
than a filesystem path. Snapshot/events contain descriptors, never encoded image bodies. Preview reads
are bounded to 16 MiB; each transcript retains at most eight previews / 32 MiB of compressed image bytes.
Additional expanded sections wait for another image to collapse. Collapse, hiding or switching sessions
cancels pending requests and releases native image resources. Kitty/Sixel-capable terminals render the
image; other terminals show an explicit compatibility message. History preview shows attachment headers;
open the saved session in Agents for image previews. Updated service code is required for descriptors
and image reads; existing services are never automatically restarted.
Empty conversations show a subdued, centered logo without introductory text or an idle `Ready` row.
The temporary artwork is isolated in `src/ui/radian-logo.ts` so the finalized logo can replace it
without changing transcript behavior. Short viewports use a compact mark; the first message replaces it.

The former pinned **Request** row is removed; the original user message remains in the transcript.
A passive work-status row above the prompt shows a shared spinner and
`Working (12s · esc to interrupt) “request”`, with only `esc` in bold, using
the latest request actually present in the selected conversation. Whitespace collapses and long
text is clipped on grapheme/cell boundaries. Drafts, rejected input and handled commands never
replace that request. Without request metadata it shows `Working (12s · esc to interrupt)`, not a guessed title.
Elapsed time starts at zero, uses runtime-owned timing across reconnects and advances locally while
visible. Compacting uses `Compacting context` with the same timing and interruption hint.
Narrow rows retain elapsed time, shortening the caption or omitting the hint as needed.
Manual and automatic context compaction show `Compacting context` with the same animated
spinner and no previous-request caption. Automatic work resuming after compaction restores its
current request. Compaction-specific progress requires an updated service; older services omit this
optional activity metadata.
Normal completion removes this request banner and puts the request excerpt in the answer's completion
footer instead. The empty status row collapses once its spinner tail finishes, unless owned-subagent
feedback still needs it. A cancelled run appears only here as `Cancelled (12s) “request”`:
the label uses the theme's warning color, the settled duration is muted, and the request uses the
normal text color. Its elapsed time freezes at confirmed cancellation, not at the initial key press.
Without timing metadata, the label is simply `Cancelled`; no duration is invented.
Partial responses remain visible, but cancellation does not create an Agent error card or a duplicate
completion footer. Unconfirmed stops and failures remain explicit as `Stopped` or `Failed`.
Without reported active work or a terminal outcome, status text stays empty even with transcript content.
Hidden spinners reserve no slot or gap, including after their minimum-visible tail ends.
Completion metadata is scoped to the latest request. Spinner tails never delay results, and
switching/hiding a conversation cancels its indicator. Steer and queue semantics are unchanged.

Sections have no disclosure arrows or separate role/status heading rows. Expanded user/Agent text
starts directly with its content. Tools use inline invocations such as `[read] path:line` or `$ command`;
folded items show an inline `(Ctrl+o to expand)` hint using the actual configured key. Agent replies
and Thinking have no tinted background, border or added indentation. Thinking uses italic text in
a theme-adaptive neutral gray, independent of accent hues or colored `muted` overrides.
User, tool and notice blocks retain subtle host-palette tints and one row of internal padding above
and below their content, including folded tools and single-line skill labels. Plain Agent replies
and Thinking have no internal vertical padding. The transcript's parent column owns the one-row gap
between visible section surfaces and the leading gutter, but adds no bottom padding. The Agent
view owns the one-row boundary gaps between the transcript, optional work-status row and input
group, including below the final Context compacted card. Legacy unstructured output keeps its
internal spacing.

Agent answers and Thinking use OpenTUI's `MarkdownRenderable` for headings, emphasis, links,
lists, fenced code and tables. Tool commands/results, user messages and explicit skill names remain
literal text. Thinking keeps its neutral-gray italic style, including Markdown/code/table content.
Tables use bordered grids with word-wrapped cells, including during streaming.
Incomplete streaming Markdown updates incrementally; completed messages finalize after native
highlighting, without hiding their initial prose or code while the bundled grammars initialize.

`Enter` on formatted prose adds a **read-only cursor without revealing Markdown source**. Character,
word and logical-line selection operate on native visible text; visual-row movement and link targets
use the native Markdown layout. `Esc` returns to Sections without changing formatting. Section-mode
`y` and whole-section `Y` always copy the original source. The same formatted reading surface is used
by read-only History previews.

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

**Leader, then [** enters output navigation in both Agents and Terminal (`output.read`). In Agents,
**Esc** returns through Visual, Text and Sections to the input; **i** returns directly from Sections/Text
without sending the draft. There are no default Ctrl+T/Ctrl+E or leader-o aliases. All commands remain configurable:

| Mode | Default keys | Action |
| --- | --- | --- |
| Sections | j/k or Ctrl+N/P; Home/gg and End | Previous/next or first/last section |
| Sections | Enter | Read formatted prose, folded heading/summary, or literal body with the cursor |
| Sections/Text/Visual | Ctrl+O (also za); zm/zr | Toggle the selected section; fold/unfold all |
| Text/Visual | h/j/k/l or arrows | Grapheme/visual-line cursor movement |
| Text/Visual | w/b; 0/$ or Home/End; gg/G or Ctrl+Home/End | Word, logical-line and section boundaries |
| Text/Visual | v / V | Character selection / whole-logical-line selection; repeat the same key to stop |
| Text/Visual | gx | Open the HTTP(S) link under the cursor in the system default browser |
| Visual Line | j/k | Move by logical source lines, including wrapped paragraphs |
| Sections | Ctrl+D / Ctrl+U | Jump the selected section down/up roughly half a viewport |
| Text/Visual | Ctrl+D / Ctrl+U | Move the cursor down/up half the transcript viewport |
| Sections/Text/Visual | y | Copy the section, current logical line, or selected range, respectively |
| Sections/Text/Visual | Y | Copy the whole raw section, including folded details |
| Sections | G (Shift+g) or Ctrl+End | Jump to the actual bottom of the whole transcript and resume following |
| Sections/Text/Visual | ge | Jump to the latest output and resume following |
| Sections/Text/Visual | PgUp/PgDn; F1 | Page; open/close scrollable keyboard help |
| Visual/Text/Sections | Esc | Return to Text, Sections, then Input |
| Sections/Text | i | Return to input |

**Enter never changes folding or Markdown formatting**. It enters text navigation over the visible
heading/summary, formatted prose, or literal body. Headings, emphasis, code highlighting, links, lists
and native table grids remain rendered; entering or leaving cursor mode does not replace their layout.
The decorative skill tag is not part of selectable text. `y` copies the displayed logical line or
selection; in Sections it copies the raw section. `Y` always copies the complete raw section, even when
folded. Heading and body cursor positions are retained independently. Formatted reading uses native
visible text and layout rather than treating source offsets as display positions. Old source-mode
cursors/selections are reset when formatting changes their coordinate space; new rendered positions
are retained across resize, streaming, session switches and reconnect.

`gx` (`transcript.open-link`) opens the URL under the read-only cursor, including an inline Markdown
link's displayed label, including table cells. Click a rendered link or a URL in literal text to open the same target;
dragging to select text and modified/right clicks do not activate links. Opening preserves drafts,
source text and keyboard selections. Only absolute HTTP(S) URLs are accepted; file, command and
other application schemes are rejected. The attached TUI invokes the OS default URL handler (`open`,
`xdg-open`, or `rundll32.exe`), never a shell or a Chrome-specific command. Tab/window placement follows
the browser's settings. On SSH or headless hosts this may be unavailable or target the remote host,
not the local desktop. Failures are reported without automatic retries; a timeout does not prove that
no browser opened. The command can be remapped or disabled in the shared keymap and is not active in
the prompt or embedded programs.

Shared Visual bindings also apply to **Visual Line**. `V` selects whole logical lines of the active text
surface, never inserting soft-wrap breaks or an invented EOF newline. Literal text retains its original
LF/CRLF endings; formatted selections copy the displayed text, not hidden Markdown delimiters. `v`/`V` can switch selection kind while retaining the anchor. Both kinds survive streaming,
resize and warm reconnect. In Sections, `Ctrl+D/U` jumps the selected section by roughly half a
viewport, accounting for rendered section heights and gaps. Each jump advances at least one section
when possible and reveals the new selection without scrolling unnecessarily. In Text or Visual,
`Ctrl+D/U` still moves the cursor within the current section. To jump between sections while reading,
press `Esc` to return to Sections, then use `Ctrl+D/U`, j/k, gg or End. A selection first needs `Esc` to
return to Text.

The former `INPUT · section/count · following` row is removed. Source/Visual/help mode and a
`Paused` indicator appear only when relevant in the one-row footer; `Paused` refers to viewport
following, never agent execution. Following is based on the viewport: at the bottom it follows new output; moving above the bottom pauses it;
returning to the bottom by wheel or paging resumes it automatically. Live Agent transcripts hide
their vertical scrollbar and reclaim its column without disabling wheel or keyboard navigation.
History previews use the same hidden-scrollbar policy. Merely focusing the transcript does not pause it. Content growth and asynchronous Markdown layout preserve the pre-growth
bottom intent rather than treating the increased scroll range as user navigation. Following also
keeps the bottom on resize and when returning from another work view.

Above the bottom, a centered `↓ Back to bottom` button uses an existing blank row above the work
status or in the composer's top inset. It never adds blank rows, covers transcript content or moves
the input. It shows the effective `transcript.latest` shortcut (default `Shift+g` in Sections and
`g → e` in Text/Visual); clicking resumes
following without sending a prompt or taking input focus. It is hidden at the bottom, in help
and whenever no existing blank row is available.

Character/line selections and native mouse selections temporarily protect their viewport. Once
selection is cleared, following resumes only if the viewport is still at the bottom. Auto-following
does not replace the section, cursor or selection being read. Help and the read-only History preview
remain independent of live transcript following. `G` (`Shift+g`) or `Ctrl+End` in Sections, and `ge`
in any transcript mode, explicitly jump to the whole transcript bottom and resume following. `End`
in Sections still selects the last section; `Shift+g` and `Ctrl+End` in Text/Visual still move to the
end of the current section.

A new prompt submission explicitly moves to the bottom without stealing Input focus. Merely editing
an unsent draft or inserting completion text does not discard a reading position above the bottom.
Submission changes follow intent before admission, never from a late acceptance callback: scrolling
away again or switching sessions while admission is pending cannot be overridden by the old result.
Streaming preserves section identity, explicit folding choices, cursor/selection and the viewport
anchor where scrolling permits. Copying lines/selections uses the active reading surface without
inserting display-wrap breaks; whole-section copying preserves the raw source and original line endings. Unbound keys, timed-out prefixes and paste cannot edit transcript
content. Help uses the same scroll viewport and returns to the prior position/mode when closed.

After a non-cancelled run actually settles, its final displayed section has a gray footer such as
`Worked for 1m 30s • Sep 19 at 10:55 AM`, followed by a separate request line such as `“Review tab icons”`.
The running `Working` block also puts its request on a separate line; both use the same quotation
marks and keep attachment badges outside them.
The excerpt comes from the actual preceding user/skill request, never a draft or assistant output.
Duration, completion date and time keep their existing format on the first line. The request caption
uses its own one-line width below it; only the caption is shortened, not the original message.
Actual SDK image blocks and explicit Radian `@"absolute path"` file references produce attachment
badges. A single file uses its basename when it fits; narrow views fall back to counts. Badge space
is reserved before shortening request text. Image data and full file paths are not copied into badges.
Request previews are bounded to 4,096 UTF-16 units on grapheme boundaries; source messages remain intact.
These optional previews need updated service code. Older services/sections keep a text-only caption,
without guessing attachment counts from filenames or image-like text. Services are never restarted
automatically. At widths too small for the timing metadata itself, its existing wrapping is retained.
Runtime monotonic time measures processing from the first
`agent_start` through final `agent_settled`, including tools, retries, compaction and coalesced queued
follow-ups; intermediate model/tool endings do not finalize it. Queued input joined into one SDK run
shares one completion record using the latest delivered request excerpt, rather than inventing separate
per-prompt durations. A subsequent run with no delivered request does not borrow the prior run's
excerpt. Idle time between runs is excluded.
The completion timestamp is formatted in the attached UI's local timezone. Failure and unconfirmed
outcomes use `Failed after` and `Stopped after`, never `Worked for`. Confirmed cancellation keeps
its saved completion metadata but is displayed above the prompt instead of in a transcript footer.
Persistence warnings remain visible even when a cancellation footer is suppressed.
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
the legacy 12-message/12,000-character preview. Aggregate workspace snapshots have a **64 MiB receive
limit**, separate from the 8 MiB command/PTY limits; transcript paging is not implemented. Older
services remain usable with a clearly marked legacy preview. Finish their jobs and explicitly stop/restart them to load the new capability; no service
is automatically restarted.

### Agent session commands

The Agent prompt completes and executes these host commands instead of sending them to the model:

- **`/accounts`** opens account switching. The first screen lists saved accounts and existing
  connections with configured authentication; unauthenticated providers are not shown as accounts.
  Choose **Add account** to see supported providers, choose OAuth or API key, and name the new account.
  Accounts and credentials are shared by the daemon; each **worktree** uses its own account per
  provider. Adding an account never changes the active account: select it explicitly after signing in.
  OAuth opens the browser and always displays the URL with copy/reopen controls;
  device codes and manual-code prompts are shown when the provider requests them. API keys and
  authorization-code input are masked and never enter Agent drafts or conversation history.
  **/** searches, **Ctrl+N/P** moves candidates in either focus, **j/k** navigates results, and
  **Ctrl+D/U** jumps half a list viewport. **Ctrl+C** clears only the search query. **Enter** switches
  the account for this worktree, **x** opens local-account deletion confirmation, and **Ctrl+R**
  refreshes the account list. **Esc** goes back or cancels login and restores input focus.
  Already-sent model requests finish with their original credentials; subsequent calls, including
  calls after tools in the same Agent run, use the new account. Conversations and models are retained.
  An active account must be changed in every affected worktree before it can be deleted. Deletion
  removes only Radian's local credential, not the provider account, remote authorization or history.
  **Existing login** and **Existing API key** appear only when existing authentication is configured,
  using its original credential store or environment without copying secrets. **[Active]** marks the
  account used for that provider in this worktree, not a successful live authorization check. Revoked
  credentials may require signing in again. Supported login methods are shown only under **Add account**.
  If an existing connection cannot be checked, the popup shows a warning and keeps saved accounts available.
  Missing named accounts fail closed, never silently falling back to environment authentication.
  Named credentials and selections are stored atomically in the daemon's private `accounts.json`
  (directory mode `0700`, file mode `0600`; this is not an encrypted vault). OAuth receives a stable
  installation ID. If token rotation succeeds but saving fails, Radian keeps the refreshed token in
  memory and displays a storage warning: repair storage before restarting the daemon. A known remote
  OAuth account cannot be added again under a second label, avoiding competing refresh owners.
  The legacy `pi-accounts`
  extension is excluded before import on startup and `/reload`, without modifying Pi CLI settings
  or importing its tokens. The `accounts` service capability is required; older services must be
  explicitly restarted after existing jobs finish. The command accepts no arguments or images.
- **`/model`** opens a model-and-effort popup for the **current session**. Models come from Pi's
  authenticated chat-model catalog, including configured and extension-provided models. The list starts
  focused: use **j/k** to move, **h/l** to change effort, and **Tab/Shift+Tab** to move between the list
  and editable effort controls. Arrow keys remain available. Press **/** to search by model name, ID
  or provider; while searching, hjkl are literal input and **Ctrl+N/P** navigate matches.
  Model and effort clicks only stage choices. **Enter** commits the pair in one operation;
  **Esc** discards unsubmitted choices. The popup has no close icon or action-button row. The current
  model is marked and only SDK-supported effort levels are offered, using Pi's clamped preview of the
  session's current effort. Models without
  reasoning show a read-only `off` effort. The current model can stay selected while changing effort only.
  Changes preserve the conversation, update input telemetry together and use Pi's SDK lifecycle. Both
  settings are saved in that conversation for resume, never as global defaults or another tab's settings.
  No model prompt is sent by lookup or selection. Busy sessions reject changes without interrupting work.
  The additive `model-selection` and `model-effort` service capabilities are required; older services
  report an explicit upgrade notice and are never automatically restarted. The command takes no
  arguments or images.
- **`/history`** opens the saved-session History popup for the **active worktree**, just like
  **Ctrl+Space → h**. It preserves the current conversation, running work and transcript reading
  position. No model prompt is sent; **Esc** closes the popup and returns focus to the input.
  The command takes no arguments or images.
- **`/new`** creates a fresh session in a **new tab in the same worktree**, using the same creation
  path as the session strip's `+` / `session.new` action. Existing tabs, conversations, running Agents,
  owned subagents, queued input and saved history remain intact. The Agents UI selects the new tab
  once it is observable, unless the user has meanwhile selected another tab/worktree or the source
  conversation has changed. A creation failure retains the command and original tab.
- **`/clear`** replaces the conversation in the **current tab**, retaining its position and tab count.
  It prepares a fresh SDK session, stops and settles that tab's current Agent and owned subagents,
  then switches to the new conversation. Pending input for the outgoing conversation is cancelled,
  never replayed into the new one. The outgoing saved conversation remains in History;
  modified files are not rolled back. Other tabs, editors and terminal shells keep running.
  A preparation failure leaves the previous execution intact. Extension cancellation and session
  lifecycle hooks are respected. This is the former `/new` behavior; it resets the current conversation,
  not saved history.
- **`/exit`** closes the **current session tab**, using the same close path as the tab's `×` /
  `session.close` action. It stops that session's Agent and owned subagents and cancels its pending
  input. The saved conversation remains in History; modified files are not rolled back. Other tabs,
  editors and terminal shells keep running. Closing the last tab shows the empty Agent view, not an
  application exit. As with the close button, the tab disappears when closing starts while execution
  cleanup finishes in the background. The `session-exit` capability is required; older services reject
  the command without sending a model prompt or automatically restarting.
- **`/reload`** reloads the current session's actual SDK extensions, prompt templates and Skills, then
  replaces its command/Skill catalog and refreshes that worktree's UI file index. It preserves the tab,
  saved conversation, transcript, model/effort and Fast selection; it does not restart the runtime.
  The session and its owned work must be idle, otherwise reload is rejected without interruption.
  Failed resource loading retains the last successful catalog and reports that SDK resources may have
  partially changed. A local index failure after a successful SDK reload is an accepted action with a
  warning, not a rejected reload. Host overrides, including disabled cache warming, remain enforced.
  Trusted extension reload lifecycle hooks still run. The `resource-reload` capability is required.
- **`/compact [instructions]`** invokes Pi's manual context summarization for the current conversation.
  It may make summarization model calls and consume quota. It keeps the tab, saved conversation
  and full displayed transcript; only the model context is compacted. During compaction the work-status
  row shows `Compacting context…` and a spinner instead of the previous request. On success the progress
  label disappears and the resulting `Context compacted` section starts folded. The session
  must be idle: running/queued input, compaction and owned work cause an explicit busy rejection,
  without interruption. Empty or too-small context is rejected without a model request.

These commands do not accept image attachments; `/new`, `/clear`, `/exit` and `/reload` take no arguments. Rejected commands retain
input. Accepted long-running actions report progress; acknowledgement is not completion. A valid
compaction failure belongs to that conversation rather than a second global error notification.
`/clear` resets that tab's transcript navigation. `/new` and `/reload` preserve the outgoing tab's
navigation, selection and scroll position. Both preserve input edited while acknowledgement is pending.
Conversation IDs fence delayed input and control requests so an operation intended for the outgoing
conversation cannot execute in its replacement.

`/compact` uses the additive `session-controls` capability. The separate `session-tab-commands`
capability is required for the new `/new` and `/clear` meanings. New clients reject unsupported
commands rather than sending them as model prompts, invoking legacy in-place replacement or
restarting services. The legacy typed wire action `new` retains its replacement meaning for older
attached clients; new clients send explicit `new-tab` and `clear` actions. Finish existing work and
restart the service explicitly when ready to upgrade.
Neither automatic strategic-compaction suggestions nor a model-callable compaction tool is added.

### Agent input status

A passive row below and outside the prompt box, with one blank row above and below it, shows the
active worktree and branch, selected model, effort and current `fast` setting, followed by
**context remaining** and **account usage**. Worktree/branch updates follow the active workspace,
not the sidebar cursor. Long scope labels are shortened on grapheme boundaries to at most one third
of the row; known resource percentages take precedence in constrained space.
Model, effort, fast and context have outline-robot, brain, lightning and database icons respectively.
Both meters use the same block-bar style. Context explicitly reports the percentage `left`.
The account meter pairs its provider logo with lowercase `chatgpt`, `openai` or `claude` when space permits;
`18% used 1h 20m` means consumption followed by time until reset, without a middle-dot separator.
Reset times use `5d 23h`, `1h 20m` or `18m`. The compact meter selects the longest returned
quota window; all returned windows remain available in the IPC snapshot. There is no refresh button.

Filled bar cells fade from the terminal's accent toward the panel color; empty cells stay subdued.
Context labels and known values use the same foreground as account usage. Model names use the theme's
success (green) color, effort uses keyword, and `fast` uses number (yellow/gold) when on or muted when off;
unknown values and separators stay muted. These are terminal palette roles, not fixed product colors.
The prompt surface reaches both edges of the Agent pane; its internal padding aligns the editable
text with the work-status and telemetry rows. No permanent sidebar or divider reserves any width.
The prompt has no borders in either mode. When empty it shows the muted `Ask to do anything`
placeholder; the placeholder is never submitted or persisted as a draft. Focus retains the same background.
Normal work keeps its existing spinner and colors. Fast work uses a fixed three-cell yellow arrow
indicator (`▶▷▷`, `▷▶▷`, `▷▷▶`) in its session tab and Working row. Tab frames and close buttons do
not move between arrow frames. Only the Fast `Working` word shimmers; elapsed time, the interrupt
hint, request caption and passive `fast on` metadata stay static. Hidden work views stop their effects,
and read-only previews do not shimmer. These are display effects, never a priority-speed guarantee.
Working shows its gray request summary on a second line, aligned with the start of the spinner and shortened
on grapheme boundaries. Very short layouts collapse it into the existing single-line presentation
before sacrificing the input or conversation. Status height changes preserve the transcript reading
anchor and follow intent. Back to bottom uses only an existing blank boundary or composer inset,
never either occupied Working row.
The transcript, optional work-status block and input group use a one-row parent gap;
neither the transcript end nor work-status row adds its own boundary padding. Pending messages,
the composer, completion candidates and padded telemetry remain adjacent inside the input group.
Constrained windows retain usable input and conversation space before adding boundary gaps or
prompt padding. The lower telemetry keeps its one-row gutters. A temporary
zero-height conversation viewport is hidden rather than painting over adjacent controls, and
closing completion restores its position. Narrow panels shorten bars and omit settings or the
countdown before dropping either resource percentage. Theme changes preserve the current draft and focus.

Provider logos reserve two columns. On terminals reporting Kitty/Sixel graphics and pixel resolution,
OpenTUI renders a font-derived, theme-tinted image with approximately 1.5x the ordinary glyph width,
within the same row. Popup backdrops change the logo's colors without changing its image size;
model, effort, fast and context symbols retain their ordinary font scale. Other terminals retain a
bold Nerd Font glyph; individual character scaling is not assumed. No terminal font settings are changed. Asset attribution is in
`src/ui/provider-icon-data.LICENSE`.

Context comes from Pi's usage estimate and model limit. When Pi reports unknown usage after
compaction, Radian locally estimates the current system/tool checkpoint, summary and retained messages
with Pi's token estimator, without reusing pre-compaction usage. The estimate uses the same percentage
and bar without an approximation marker; SDK usage takes precedence as soon as it is available again.
Context calculations are cached by finalized conversation position and model, not repeated for streamed
tokens or repaints. Missing model limits remain unknown. Existing repository services need an explicit
restart to load this fallback; reopening only the TUI does not update it.

Radian supplies `/fast [on|off|status]` for OpenAI Responses/Codex models, including
prompt completion. Its per-model, per-session state starts **off**, so a restored session does not
remain unknown merely because it has not sent a request. `/fast on` opts into `service_tier: priority`;
`/fast off` removes an explicit priority/fast tier. These commands themselves never invoke a model, publish a transient Working state or
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
While any TUI is attached, the runtime normally polls every 60 seconds and at returned reset deadlines.
Failures retry with exponential backoff (60, 120, 240 seconds, capped at 5 minutes), with up to 10% jitter
within that cap. A longer `Retry-After` takes precedence, and successful lookups reset the backoff.
A successful `/reload` also requests fresh usage immediately, bypassing local backoff and cached results.
Server-provided `Retry-After` deadlines and in-flight request sharing still apply; a failed manual lookup
continues the existing failure count rather than resetting it.
Retry deadlines remain scheduled even when a regular poll falls inside the waiting period.
Account identity is checked during each lookup; external login changes are picked up on the next lookup.
Each worktree has its own SDK model runtime and usage monitor. Sessions in that worktree share
account-keyed lookups; separate worktrees do not share usage caches. Explicit account selection
invalidates usage immediately, and late responses from the previous account cannot republish its quota.
Detaching all TUIs stops periodic polling. Shutdown aborts lookups and invalidates late responses.

The countdown is calculated locally and ticks every minute or at its reset deadline, without HTTP requests.
Resetting a window triggers another lookup, never an invented 0%/100%. While recovering from a failed
lookup, the last successful, unexpired account bar stays visible in muted gray with a gray spinner;
its percentage, unit and countdown stay hidden throughout backoff and retries. The first lookup also
shows the spinner, without inventing a bar when no successful value exists. Success immediately restores
the current percentage and normal bar colors. Hidden views and static history snapshots do not animate.
Missing or unsupported usage shows the provider icon and **-**, without a bar or fake countdown.
Typed failure codes and the last successful timestamp remain in the snapshot for diagnostics.
Credentials and private account/cache identifiers are never sent to the TUI or saved in its preferences. Restoring history always uses live usage rather than saved quotas.
Earlier telemetry snapshots with only `weekly` remain readable and are converted to `used` for display.
Finish existing jobs before explicitly restarting an old runtime to load the new usage source.

### Agent Dashboard

Open **/dashboard** from the Agent input, or press **Ctrl+Space d** (the configured leader followed
by `d`). Opening it never sends a model prompt or interrupts work. Esc restores the previous focus
and preserves drafts. The shortcut is configurable as `dashboard.show`.

The dashboard shows only **total tokens**, **recorded runs**, and **total run time** above a daily
bar chart. Select Tokens, Runs or Run time to change the chart. Today, 7-day and 30-day filters use
local calendar dates; Project cycles between all discovered repositories and individual projects.
The resource tabs show horizontal bars with exact values:

- **Skills:** explicit skill commands and successful skill-file loads combined by skill name.
- **Models:** input, output, cache-read and cache-write tokens grouped by provider/model. Reasoning
  tokens already included in output are not added again. Context occupancy is not consumption.
  Tool-reported nested model usage without a model identity is shown as **Tool work (unattributed)**.
- **MCP:** recorded server calls, including structured nested calls, without double-counting gateway
  wrappers. Native server metadata preserves the original server name when available.
- **Subagents:** execution calls grouped by agent name, not a main-versus-child token comparison.
  Management requests such as list/status are excluded; structured workflow child results are counted
  when present. Scripts without stored server/child metadata report a coverage warning, not invented counts.

Tab/Shift+Tab moves between filters, chart metric, resource tabs and the read-only body. Tab strips
support Ctrl+N/P and h/l; the body supports Ctrl+N/P, j/k, Home/End and Ctrl+D/U half-page scrolling.
Changed bindings appear in the footer; routine default navigation is kept in Help. Use r or Ctrl+R to
refresh. Lookups run on open, filter changes and explicit refresh, not on every rendered frame.

Statistics come from bounded, read-only scans of the discovered SDK session files, including closed
sessions and raw pre-compaction/alternate-branch history. Shared entry identities copied by forks are
counted once within a repository. Run counts and duration use Radian's recorded settled-run metadata;
older conversations without it still contribute tokens but cannot supply reliable run timing. Times
are summed elapsed run durations (including overlapping work), not time spent at the keyboard.
Expired/deleted histories are not reconstructed. Missing/corrupt records and unsupported repository
services produce explicit errors or partial-coverage warnings; authentication and transcript bodies
never leave the runtime as dashboard data. An old runtime must be restarted explicitly after its work
is finished to enable this feature; opening the dashboard never restarts it automatically.

### Native Git

Git opens directly into the full-width **Commits** main view, without Commits/Reflog/Refs tabs or a
permanent right panel. **b** opens the searchable Refs modal; **Ctrl+R** opens searchable Reflog with a
read-only target-commit preview. **r** remains Refresh. All bindings can be overridden and appear in the
footer. Workspace navigation stays in its shared popup; Git does not duplicate worktree navigation or
provide submodules.

Refs searches local branches, remote-tracking branches and tags together, grouped by kind rather
than separated into tabs. Candidate navigation never changes the checked-out branch or applies a
filter. Enter applies the selected ref filter and closes the modal; **All refs** clears it. The main
view shows the active ref filter. Esc closes a modal without discarding an applied filter; Esc in the
main view clears that filter.

Reflog lists event time, selector, short hash and event message. Its local text search matches event
messages, branch names in those messages, hashes, selectors and timestamps. The preview separates
**Occurred** event time from the target commit's author date and shows its full metadata/message,
not a file diff or an inferred reset/checkout transition. Preview lookups are cancellable and cache
up to 16 recent results by target hash, while different events keep their own descriptions. Enter
closes Reflog and opens the target commit's Changes popup, even when that commit is only reachable
through reflog and absent from the filtered/bounded main graph. Closing that popup restores the
previous main selection and reading position. Unsupported, missing or pruned targets show an explicit
error rather than an empty successful comparison.

Both modals use the shared SearchInput. Ctrl+N/P navigates candidates from either search or results;
j/k also navigates results. Ctrl+D/U from search preserves query/caret, reveals and focuses results,
and jumps the candidate cursor by half a viewport; held repeats continue from that cursor. Ctrl+C
clears only the query, including from results, and is a no-op when empty; Ctrl+L is not an alias.
Search treats unmodified h/j/k/l/a/y as text. Reflog preview is beside the list on wide terminals;
Ctrl+O toggles list/preview on compact terminals, and Tab/Shift+Tab cycle through the modal's regions.
Ctrl+D/U scrolls the preview body while that body owns focus.

Commits places ref labels in a dedicated left column, connected to their commit nodes. Multiple refs
share one caption with a +N count; long captions are truncated on terminal-cell boundaries. A stronger
node-colored background band connects the graph to each commit message without a decorative horizontal
line, followed by two neutral cells before the message. Working tree has no connecting band, while
keeping messages aligned with commit rows. Parent lanes and ref-to-node lines remain intact.
The left column always reserves the responsive details-card width, including on Working tree and
while history is unfocused, so the graph and messages do not move horizontally as focus changes.
Focusing a selected commit reveals a fully unfolded details card anchored to that row; commit row
heights do not change. The card has no internal scrollbar, height cap or redundant title and includes
the complete hash, author, date, message, HEAD status, local/remote branches and tags. Branches and
remotes are queried with `for-each-ref --points-at`: only refs whose tips match the selected commit
are displayed, not every branch containing it in history. Remote refs use locally available
remote-tracking data, not a network lookup. Tags and graph labels also identify refs pointing directly
at a commit.
Branches, remotes and tags appear above author/date; `—` denotes a completed empty result and `…`
marks branch refs that have not loaded yet. Commits without tip refs still have details.
Cards taller than the terminal extend the shared Commits viewport instead of clipping text or
introducing nested scrolling. Tab focuses the card; Ctrl+D/U and the mouse wheel move that shared
viewport, Home/End reach the card's ends, and Esc returns to the history cursor. Moving focus outside
history/details hides the card but keeps the column width reserved for ref labels.
Dragging details text still copies it, but the card has no separate `a` or `y` action.

The initial selection is Working tree, with staged, unstaged and untracked changes. A commit compares
against its first parent (or empty content for a root commit). Staged compares HEAD/index, unstaged
compares index/worktree, and untracked compares empty/worktree. A staged rename followed by an
unstaged edit uses the new index path. Git queries disable optional locks and external diff/textconv;
they never stage, commit, push or change branches.

Enter on a commit or Working tree opens a large changes popup containing only changed files on the
left and a whole-file Before / After comparison on the right. A short title identifies the commit;
metadata remains in the main history's left column rather than consuming diff space. The first file
is loaded automatically, and selecting another file updates the comparison without closing the popup.
Both diff columns share one keyboard-focus target and synchronized wheel/keyboard scrolling.
Tab / Shift+Tab cycle only between files and diff. Esc closes the popup and restores the prior history
selection and shared reading position. Empty commits show an explicit no-changed-files state.
Unchanged content is included, not silently omitted by a default short-context patch.

Git-specific actions are scoped to Git browsing controls and can be rebound in the normal keymap:

| Focus | `a`: attach to an Agent prompt | `y`: copy the complete identifier |
| --- | --- | --- |
| Commit history row | Commit hash only | Full hash |
| Commit details | Not available (read-only) | Not available; drag text to copy |
| Changed file / entire Diff | Relative path and historical revision/change identity | Relative path |
| Local / Remote branch result | Name only; no automatic tip hash | Name, including remote prefix |
| Tag result | Name only | Name |
| Reflog event result | Event details and target hash | Full target hash |

`a` freezes the chosen context and opens a small prompt showing its target session. The default is the
last selected session in that worktree. **Ctrl+S** (`git.change-session`, configurable) cycles through
that worktree's sessions and **New session** without modifying the prompt or creating a session.
Enter submits through the same runtime path as Agent input, including SDK steering when busy;
New session creates one only on submission. Esc cancels. There are no session-change, Send or Cancel
buttons; Tab keeps focus in the prompt.
The existing Agent draft is untouched, and sending keeps Git visible. No extra execution-status or
Agent-navigation panel is added. Prompt typing treats a/y as ordinary text; A/Y actions do not exist.

Click selects; dragging selects text without activating a row. Releasing a drag automatically copies
its text, excluding graph decorations and line numbers. Split comparisons clamp selection to the
starting code column. `y` still copies the focused object's identifier, regardless of text selection.
Local clipboard writes use OpenTUI's clipboard service. Remote terminals use OSC52 when available,
without writing an unrelated remote host clipboard. OSC52 is reported as a **request sent**, not
confirmed clipboard contents; unsupported/failed delivery is reported explicitly. Real SSH terminal
acceptance depends on the terminal/multiplexer configuration and is not assumed from dispatch alone.

`j/k` or `Ctrl+N/P` navigate, Enter opens the selected commit or focuses a selected file's diff,
r refreshes, + loads another 300 commits, Home/End jump, and PgUp/PgDn scroll. Refresh is keyboard-only;
the main spinner overlays a reserved upper-right cell without adding a navigation row or shifting
history. Browser and Changes popups own their own spinners, canceled when hidden, with the same
minimum-visible policy and no delayed result/error handling. Diff `j/k` or `Ctrl+N/P` scroll both columns vertically, and `h/l` scroll them horizontally. History is bounded to
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

Entering **Terminal** automatically starts one shell if the selected worktree has none.
Existing shells and the last selected tab are reused without creating another shell. Use
**Ctrl+Space, then n** for additional terminals, from either input or the empty view; there is no
**+ New** button.
Each worktree has an independent list of shells; creating one selects it unless later navigation
supersedes that request. Each tab uses the same fixed-width frame and right-aligned **×** as Agent
sessions; there is no shared **Close** button. Closing an inactive tab leaves the active shell and
input focus unchanged. Closing the selected tab selects its next/previous neighbor, or leaves an
empty state with the configured new-tab shortcut.
While a terminal tab is focused, `h/l` or `Ctrl+N/P` switches to its neighbor without leaving the
strip. Enter or Space opens the selected terminal input. Shell input retains native **Ctrl+N/P**
and other program bindings; only the configured leader sequences are reserved for app actions.
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
no replacement shell is started until you re-enter Terminal or request one with the new-tab shortcut.
Automatic cleanup also runs while the TUI is detached.
There are up to **5,000 scrollback lines per shell in memory**, navigated with the wheel
or default Shift+PgUp/PgDn. Typing returns to live output. History/viewport survive warm reconnect;
radian does not save terminal output/commands to its manifest. A live shell may save its own
history according to its user configuration.

**Leader, then [** enters read-only output navigation, using an on-demand plain-text snapshot of the active
screen and retained scrollback. Shells and jobs keep running; new output does not replace the text
being selected. The footer shows **NORMAL**, **VISUAL** or **VISUAL LINE** and `frozen output`.
Use h/j/k/l, arrows or Ctrl+N/P to move, w/b for words, 0/$ for line bounds, gg/G for buffer bounds,
and Ctrl+U/D or PgUp/PgDn for half/full pages. **v/V** selects characters/logical lines; **y** copies
the selection or current line, returning to Normal after accepted clipboard delivery. Copy failures
retain the selection. Soft-wrapped terminal lines are joined rather than copied as artificial newlines.
Esc cancels Visual selection, then returns from Normal to shell input; **i** returns from Normal directly.
Unbound keys and paste never edit the snapshot or reach the shell. Ordinary shell input retains
Esc, Ctrl+C, Ctrl+N/P and other program bindings. Tab-strip navigation and leader-1 through leader-9
still select shells; there are no default leader-[ / leader-] previous/next-terminal bindings.

Copy mode requires the additive `terminal-copy-mode` runtime capability. An older running service
reports that copy mode is unavailable and keeps its shells intact; save work and explicitly restart
that service when ready. No service is automatically restarted. Snapshots are not persisted or streamed
with every terminal frame; an oversized snapshot is explicitly rejected at the 4 MiB safety limit.

Closing a tab stops its shell and other processes in its **owned POSIX session**, including ordinary
foreground/background development servers. Each tab retains a Bun supervisor as the
session ownership anchor until its cleanup completes, including after shell exit. The runtime verifies
the live anchor and kernel `getsid()` membership before signaling **individual positive PIDs only**. It never uses `ps sess`
values or negative/group/broadcast kills, and refuses cleanup on lost ownership. Graceful termination
is followed by bounded escalation for still-owned processes; failures remain tracked and are reported.
`runtime-status` reports the supervisor `pid` separately from `shellPid`.

This boundary does not claim control over processes that intentionally escape into another session,
remote services, privileged jobs the user cannot terminate, or arbitrary effects of shell commands.
Hard runtime death may leave processes behind; there is no automatic command replay.
Entering an empty Terminal view after a restart starts a fresh shell, not the previous command.
Explicit `--stop-runtime` closes all tracked terminals and their owned jobs. Existing services without
`terminal-tabs` are not silently upgraded. The new view preference is stored in
additive fields so the original three-view wire enum remains readable by older clients.

### Theme

The UI follows the attached terminal by default: text/background use its default colors, while
accents, status indicators and Git graph/syntax colors use its ANSI palette. Muted text, selection,
footer and diff backgrounds are derived from those colors for both light and dark terminals.
Reported palette changes repaint the UI without restarting the runtime or losing prompt drafts,
focus or Git navigation/scroll positions. Each attached TUI has its own theme.

Git has no view or ref-kind tab strips; its searchable modal candidates keep a visible selection even
while search owns input focus. Top-level work-view tabs are omitted. Agent and Terminal session tabs use background emphasis without
underlines through the shared `src/ui/session-tab.ts` frame; an unfocused active session keeps a
subdued background. Other buttons retain their
usual focus styling. Navigation uses understated separators rather than boxed controls.
Workspace popup, Agent/Git/Terminal content and footer text use two-cell horizontal insets, reduced to one on terminals
narrower than 80 columns. Workspace navigation never consumes permanent work-pane width.
Work views start at the top of the work pane;
there is no reserved row for top-level view navigation. Tabs, search surfaces and item gaps no longer switch height modes. The composer
retains its normal vertical padding unless fixed controls need that space. Work surfaces have no
additional top or bottom panel inset. Routine Neovim/worktree captions, the `Git · … · All refs` line
and the terminal `… · running` line are omitted; empty, error, exit and reconnect messages remain meaningful.
Agent's padded telemetry, Editor, Git history/changes popups and Terminal end at the same work-pane bottom edge,
without an unused row below them. Popup dimensions are clamped to the terminal without changing
that viewport. Embedded programs receive the measured inner viewport rather than rendering
beneath the padding. The footer text remains one row, with its gradient extending through the
product text's inset to the screen's left edge.
Keyboard focus is separate from selection: the focused workspace popup or input border uses the terminal's
accent, while an unfocused selection stays softly highlighted. Agent input has a dedicated surface.
These are presentation changes only; keybindings and embedded program input ownership are unchanged.

No theme file is required. Put optional `#RRGGBB` color overrides in the unified `theme` section.
Without that section, the legacy `$XDG_CONFIG_HOME/radian/theme.json` (defaulting to
`~/.config/radian/theme.json`) is read at TUI startup. `--theme PATH` overrides that section.
The following is the section's contents, or a complete legacy theme file:

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

Components use purpose-specific style groups on top of these shared color defaults. For example,
`status.success`, `syntax.string` and `git.graph.1` may start with the same green, but overriding
one group does not change the others. Agent code blocks and Git diffs share the same syntax groups.
Inline Markdown code defaults to the string/green color, independently of links and status messages.

Add an optional `styles` object to the same file:

```json
{
  "accent": "#7DD3FC",
  "styles": {
    "status.success": { "fg": "#98C379", "bold": true },
    "syntax.string": { "fg": "#A8DCA0" },
    "footer.key": { "fg": "#C678DD", "underline": true },
    "completion.selected": { "fg": "#7DD3FC", "bg": null },
    "markup.tableBorder": { "fg": "#5C6370" }
  }
}
```

Style fields are `fg`, `bg` (`#RRGGBB`), and boolean `bold`, `italic`, `underline`. Omitted fields
keep their defaults; `bg: null` removes an explicit background, and `false` removes an emphasis
attribute. Shared color overrides are applied first, then group overrides. `markup.heading` is
the default for `markup.heading.1` through `.6`; a level-specific setting takes precedence.
Unknown group names, attributes and invalid values are errors; arbitrary links and wildcards are
not supported. See [the complete group list](../src/ui/theme-style-config.ts) for exact names.

Groups cover common UI (`ui.*`), completion, footer shortcuts, status, model/effort metadata,
syntax, Markdown, transcript cards, sidebar, prompt, branding, diff and Git graph lanes.
Borders use foreground colors; containers use backgrounds; text/syntax use the attributes their
native renderers support. Default tab underlines, background-free completion selection, neutral
Thinking, spacing and input ownership remain unchanged. Explicit `transcript.thinking` overrides
can customize reasoning independently of ordinary syntax and muted text. Palette or style changes
repaint existing owners without replacing their drafts, selections or navigation state. `--no-color`
continues to strip colors while preserving selection emphasis, including custom selection backgrounds.

If color queries are unsupported, native default/ANSI color intent is retained. Derived colors use
fallback snapshots (light when the terminal reports light mode, dark otherwise); explicit overrides
can correct them. Overrides affect Radian's UI only: embedded shells still follow the host terminal,
and programs' explicit RGB colors or Neovim colorschemes remain unchanged.

### Keybindings

`Ctrl+N/P` moves the current candidate, tab or read-only cursor by one step. In result lists,
`Ctrl+D/U` jumps the candidate by half a viewport of items: this applies to Workspace, History,
AI Sessions, model selection and Git lists. In Transcript Sections, it jumps the selected section by
roughly half a viewport using rendered section heights. In History/AI Sessions previews, Git
details/diffs, conversation text and help/notification details, `Ctrl+D/U` moves the focused body by
half a viewport.
From a search input, `Ctrl+D/U` preserves the query and caret, focuses the results list and jumps
from the current candidate. Further presses and held-key repeats continue navigating the list.
In compact layouts this returns from preview to results. **Ctrl+C** clears only the search query,
without closing the popup or interrupting work; an empty query is a no-op.
Agent/Git prompt editing and embedded editors/shells retain their native input bindings.
Search, completion and focused tab strips keep **Ctrl+N/P** navigation. Creation uses the separate
**Ctrl+Space, then n** sequence, not **Ctrl+N** or bare `n`.

The default leader is **Ctrl+Space**. Press and release it, then press `c` to detach radian,
`a`/`e`/`g`/`t` to select Agents/Editor/Git/Terminal, `b` to toggle workspace navigation,
`w` or `f` to open workspace search, or `s` to monitor working sessions and unread results.
`<leader> 1` through `<leader> 9` select a session in Agents or a shell in Terminal, based on the
visible view rather than the focused control. `<leader> n` creates a session/shell in that view,
including empty states; Editor and Git ignore these commands. `<leader> x` closes the selected terminal.
`<leader> [` enters Agent/Terminal output navigation through `output.read`; use focused tab-strip
navigation or leader-1 through leader-9 to switch tabs, not the removed previous/next-terminal defaults.
These shared actions can be rebound with
`tab.new` and `tab.select-1` through `tab.select-9`; `session.new` and `terminal.new` remain available
for explicit custom bindings but have no default bindings.
Ctrl+C clears drafts in Agent input; in Editor and Terminal, Neovim and shells still receive it as native input.
If macOS reserves Ctrl+Space for input-source switching, change that system shortcut or radian's leader.

Shortcut hints use Neovim notation (`<CR>`, `<C-n>`, `<S-Tab>`, `<Esc>`). Sequential keys are
concatenated without separators (`<leader>b`, `gg`, `za`), and shifted letters appear as uppercase
characters (`G`, `V`, `Y`). Alt/Meta uses `<M-…>` and Super/Command uses `<D-…>`.
Application help shows the current physical leader separately (for example, `<leader>: <C-Space>`).
Explicit key sequences without `<leader>` keep their literal labels, even when they match the
current leader. This is display-only: configuration still uses `ctrl+n`, `shift+tab` and `<leader> n`.

Keybindings are read from the unified `keybindings` section at TUI startup. Without that section,
`$XDG_CONFIG_HOME/radian/keybindings.json` (defaulting to `~/.config/radian/keybindings.json`) remains
supported; `--keybindings PATH` overrides that section. Reopen only the TUI to apply these edits;
the runtime and its processes do not need restarting.

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
`global`, `app` (outside PTYs), `pty`, `workspace`, `search`, `history`, `history-search`, `monitor`, `monitor-search`, `session-tabs`, `terminal-tabs`, `git-tabs`,
`prompt`, `prompt-completion`, `button`, `transcript` (section navigation), `transcript-text`,
`transcript-visual`, `editor`, `terminal`, `terminal-copy`, `terminal-visual`, `git`, `git-prompt`, `dialog`, or `none`. An override replaces that command's defaults;
`[]` disables it. Command IDs/defaults are defined in `src/keybindings/commands.ts`.
Unknown commands, invalid keys and overlapping/prefix bindings are errors rather than silent fallbacks.
For example, a printable Space leader conflicts with the default button Space activation unless that
binding is changed. Missing default files use defaults; missing explicitly requested files are errors.

Incomplete/mismatched sequences are returned once, in order, to their original input target. Focus
changes flush the old prefix to the old target, never the newly selected terminal. Paste is never
interpreted as commands, and kitty key-release events do not duplicate replayed text. These settings
control radian commands, not Neovim's own configuration or shell editing bindings. Configured but
currently unavailable commands are consumed without executing, never replayed as accidental edits.

### Command-first popups

App-owned popups use titles and content without top-right close icons or bottom action-button rows.
Use the configured commands to activate, submit, copy or close; necessary state choices such as model
effort remain in the content. Esc cancels unsubmitted choices, not accepted runtime operations.
Tab traversal stays within the popup's search, results, previews and editable content. Contextual
shortcuts and full Help come from the active keymap; they do not reserve a second popup footer.
Accounts uses **o** to open the login browser, **y** to copy its URL and **Y** to copy a device code
when the read-only login details have focus. In text fields those letters remain literal input;
use Tab to focus details first. Passive result notifications also omit close icons and expire normally.
Session-tab close controls and non-popup application controls are unchanged.

### Common footer

The work pane and navigation popups share one full-width footer. Its single text row places
`Radian`, its version and the **displayed work view** on the left (for example,
`Radian 0.0.0 · Agents`), with shortcuts for the **currently focused control** on the right.
The view name is subtly accented, not interactive, and does not change when focus moves elsewhere.
Below 80 columns the version is omitted; at smaller widths the view name takes priority over branding.
The footer occupies exactly one terminal row at every screen height, with no decorative row above it.
Errors and notices remain separate above it. A subtle background gradient starts at the screen's left
edge, including the product text's inset, and fades
the terminal's accent into the footer surface toward the right. It follows palette changes and optional theme overrides. Keys are highlighted separately
from their descriptions. Tree, search, History, buttons and prompt contexts update on actual focus/state changes; unrelated/global shortcuts are not appended.
The footer prioritizes app-specific actions and Help. Routine default navigation, open/close, focus,
scrolling, draft/search clearing (`<C-c>`) and Vim selection hints stay in full Help rather than occupying the footer; changed bindings
remain visible. Send/Run/Queue, newline and Agent interrupt hints are omitted even when rebound.
Native Editor normal-mode and Terminal interrupt hints are also omitted. These presentation rules
never disable the underlying bindings or remove them from application Help.
Application bindings such as `Ctrl+f`, `<leader>p` and `Tab` still work outside Neovim input focus;
the configured leader detach command works in every input context. See the input ownership rules above.

The status-icon legend and routine live-service banner are not shown. Errors and service notices
appear in a separate row immediately above the footer only when nonempty, so they never replace
shortcut hints. Clearing a notice returns its row to the work panels.
Identity and shortcut text remain read-only. A dedicated Help entry opens a centered popup without
changing the original draft or selection; closing it restores focus. **F1** opens application help
in app controls; the conversation retains its existing F1 reader help. **Leader, then ?** opens the
application popup from any work view, including embedded PTYs, without intercepting their native F1.
The popup lists the current context first, then common application bindings, including user overrides.
It traps Tab traversal and supports arrows/j/k, PgUp/PgDn and Esc.

A nonempty notification reserves exactly one row above the footer, showing its first nonempty line
with width-aware ellipsis and a **Details** action. **Leader, then !** also opens the full original
message in a scrollable, copyable popup. Notifications never open this popup automatically. Accepted
model/tool failures stay in their conversation instead of duplicating into the global footer.
Clearing the owner's notification removes the row; no permanent blank notification space is reserved.

The footer text stays one line on narrow terminals. Identity stays on the left; complete shortcut/label
pairs fit in the owner's supplied order and trailing pairs are omitted with an ellipsis. Resize
restores them when space permits. The help entry remains discoverable even when trailing context
hints do not fit (shown as F1 or ? at narrow widths). Active completion uses the configurable
`completion.next`, `completion.previous`, `completion.accept` and `completion.dismiss` commands.
Default Tab focus traversal excludes `prompt-completion`; overriding Tab globally requires rebinding
or disabling the conflicting completion acceptance binding. Input editing, Ctrl+F/E focus shortcuts,
and Neovim/shell input ownership are otherwise unchanged.
`src/ui/footer.ts` is a reusable presentation component; it does not own keyboard handlers,
workspace selection, or agent execution.

All Radian-owned horizontal scrollbars stay hidden, including overflowing Agent and Terminal tab
strips and read-only dialogs. Horizontal navigation/reveal remains enabled where needed. The live
Agent transcript also hides its vertical scrollbar; other vertical scrollbars, Git diff movement
and embedded programs' own UI/configuration are unchanged.

### In-app session notifications

An attached TUI shows newly observed main-agent results in a top-right overlay across all
already-connected repositories and worktrees, regardless of the current Agents, Editor, Git or
Terminal view or terminal focus. Completed results use success styling, failures use error styling,
and stopped or unknown-origin cancelled results use warning styling. Explicit user interruption
and lifecycle shutdown do not create new popups, matching the unread-bell policy. Individual
messages, tools, retries and subagent status changes are not separate notifications.

Cards fade in and show the result, delivered-request summary, repository/worktree and elapsed run
time when available. At most three fit on screen; smaller terminals show fewer, with excess cards
queued until space is available. Completion cards expire after five seconds and other result cards
after eight seconds of display. The overlay never changes keyboard focus or reserves workspace
layout space. Click a card to open that conversation's latest output; a closed or replaced
conversation is not opened. Automatic expiry only dismisses the popup, never the runtime-owned
unread bell. Reading the actual result uses the existing acknowledgement path.
Successful session tabs still have no check icon.

Initial attachment, newly loaded history and reconnection establish a baseline rather than
replaying past popups. Restored unread bells remain available in the session monitor. This feature
uses the additive result metadata supplied by `session-attention` services; it does not start cold
services, automatically restart older services or deliver while the TUI is detached. Terminal desktop
notifications remain a separate, focus-dependent delivery policy.

### Terminal notifications

An attached TUI requests a terminal desktop notification once for each newly settled main-agent
run that completes or fails. The title is `Radian · Task completed` or `Radian · Task failed`;
the body contains only a short task excerpt and elapsed run time, for example
`Implement terminal notifications · 42s`. Project/worktree names and session identifiers are not
repeated. The excerpt uses the latest delivered request belonging to that settled run, not a draft,
a later request or an assistant response. Skill-only requests use their invocation name, not internal
instructions. When no request text is available, only elapsed time is shown. Excerpts are sanitized
and clipped to 160 terminal cells without truncating the time. User-written request text can appear
in the excerpt; assistant responses and raw provider errors are excluded.

OpenTUI terminal `focus` events suppress notifications; `blur` enables them. Before a focus event
is received, the state is unknown and notifications are attempted. Focus reporting depends on the
terminal and any intervening multiplexer. Focused results are consumed, not replayed on blur.
Retries, individual messages/tools, subagent status changes, cancellation and unfinished runs do
not generate separate alerts. Initial attachment, resumed history and reconnection establish a
new baseline instead of replaying old completions.

Delivery uses OpenTUI's native terminal notification API, not a macOS helper or direct stdout
writes. The terminal application (for example Ghostty) remains the sender and controls permissions,
OS presentation and click behavior. Unsupported/rejected requests are not retried, and acceptance
by the terminal API does not confirm an OS banner. Each TUI owns its notification lifecycle;
detaching stops delivery, while agents continue running in the service.

### Runtime ownership and closing

One detached Bun service owns independent in-process repository registries and an SDK instance for
each open item, with an explicit worktree `cwd`. The TUI uses private Unix-domain HTTP/NDJSON to send actions
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
SDK defaults: a session with no user/assistant exchange may not have a history file. Closing retains
the same session snapshot used by runtime recovery, marked `closed`, for read-only History previews.
A missing SDK conversation does not prevent viewing that snapshot, but it cannot be resumed.

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

The shared daemon starts automatically on first workspace registration. Its process identity includes
only the state root and live/test mode, not a repository or worktree. Unix sockets are user-private
(directory `0700`, socket `0600`); manifests/logs use private files. No TCP port is exposed.
Repository-scoped Unix endpoints remain available for protocol compatibility, but every new endpoint
is served by the **same Bun process**.

Repository data stays at its existing `~/.radian/workspaces/<identity>/` location, keyed by canonical
Git repository, state root and live/test mode. `workspace.json`, `sessions/` and `sdk-sessions/` do not
move or merge. Shared process registrations and logs live separately under `~/.radian/daemon/live/`
or `offline/` (`repositories.json` and `runtime.log`). Registrations remember lazy/active intent so a
restart can restore the same repositories without replaying prompts, shells or editor commands.
Use `--state-dir PATH` or `RADIAN_STATE_DIR` to isolate another daemon and its data.

```sh
bun run start runtime status                   # Inspect the shared daemon, from any directory
bun run start runtime stop                     # Stop all repositories owned by that daemon
bun run restart                                # Restart it, preserving stored state (does not open a TUI)
bun run start --test-runtime runtime status     # Inspect the separate offline daemon
bun run start --test-runtime runtime stop       # Stop the separate offline daemon
```

Status/stop do not scan workspace roots, require a Git cwd, read UI settings or start a missing daemon.
The existing `--runtime-status`/`--stop-runtime` aliases have the same shared scope. Explicit stop and
restart retain open-session intent and saved history, unlike closing an individual session. They
interrupt Agent work and close **all** owned terminals and editors; save unsaved buffers first.
Live/test daemons and different state roots remain independent.

**Legacy migration:** old repository processes can still own live sessions and the same on-disk data.
They are never automatically killed, adopted, or allowed a second writer. Ordinary shared stop/restart
does not target them. Finish their jobs and save editor buffers, then explicitly stop each legacy
owner and reopen the TUI to register it with the shared daemon:

```sh
bun run start runtime status --legacy --runtime-cwd /path/to/repository
bun run start runtime stop --legacy --runtime-cwd /path/to/repository
```

`--legacy` is only valid for status/stop and refuses to stop a repository already owned by the shared
daemon. Existing history and repository data paths are retained; no destructive migration is needed.

Event subscriptions send the current snapshot every 5 s while idle, keeping `GET /events` alive
without disabling ordinary request timeouts. These heartbeat snapshots use the existing protocol and
do not run agents or write checkpoints. A heartbeat is used because the installed Bun 1.4.3 can still
time out streaming Unix requests after `server.timeout(request, 0)`.

A workspace snapshot includes every open session, not one prompt or one terminal viewport. Closed
session snapshots stay on disk and are fetched individually by History, not broadcast to every TUI.
Both its initial HTTP response and streamed logical frames therefore use a separate **64 MiB**
receive budget. Commands, ordinary replies and PTY frames retain their **8 MiB** limits. Snapshot
receivers count actual UTF-8 bytes incrementally, validate text only after complete frames arrive, and bound
allocation independently of network fragmentation. Multiple complete frames in one HTTP chunk are
not mistaken for a single oversized frame. Data is never silently clipped to fit. These client-side
receive changes work with already-running services; reopen only the TUI to load them.

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
- **Service restart/reboot:** open IDs, selection, drafts and saved contexts are restored from the
  checkpoint; records marked `closed` are never instantiated. Previously working agents are marked interrupted/unreported; model requests and tool
  calls are **not** automatically replayed. Submit a new prompt explicitly to continue.
- **Missing/corrupt saved history:** recovery reports an error rather than silently making an empty
  replacement. Unused items without a history file can be restored as empty items with the same UI ID.
- **Force-killed service:** SDK executions stop and stale endpoints are recovered on the next launch.
  Unlike graceful stop, hard crashes cannot guarantee cleanup of arbitrary tool subprocesses.

The Agent view uses the structured read-only transcript described above on services advertising
`agent-transcript`; the bounded recent `output` field remains for compatibility with older clients.
Runtime recovery and History share the same session-record format, containing the structured
Transcript, compatible plain output, execution/result state, subagent summaries and telemetry.
`lifecycle: open | closed` is independent of `working | complete | failure`. Explicit close and `/clear`
preserve the outgoing conversation as closed; stopping the runtime preserves open-session intent.
Records are keyed by worktree and SDK conversation ID, not the replaceable UI tab ID.

On disk, `workspace.json` storage version 2 contains the workspace/preferences and a small session
index. Session bodies are private `sessions/<identity-hash>.json` files, atomically replaced only when
their content changes. Ordinary checkpoints neither load nor rewrite old closed bodies. Recovery
loads only open records; History lazily reads the selected record. A close body published before an
interrupted index update is still treated as closed. Index and session-file updates are individually
atomic, not a multi-file transaction; persistence failures remain explicit warnings, not rollbacks.
Original inline manifests remain readable, default missing lifecycle fields to open, and migrate on
the next successful checkpoint. The new on-disk index requires an updated runtime; no running service
is automatically replaced or restarted.

Full SDK history remains in JSONL. Configured Pi extensions, including MCP adapters, use SDK discovery;
this does not embed Pi's interactive CLI UI or provide remote-machine services.

### Session retention

The default policy retains Radian-created closed conversations for **30 days after their latest
close**. Set `sessions.retentionDays` to a positive integer in unified settings, or `null` for unlimited
retention. A separate `closedAt` timestamp is recorded on close and `/clear`, cleared when the same
SDK conversation is reopened, and set anew when it is closed again. Ordinary checkpoints, usage
updates and creation dates do not reset that clock. Open or runtime-owned active sessions are never
removed. Owned subagent conversations receive closed snapshots after their work settles as well.

Only records positively marked as Radian-created (`managed`) are eligible. New hosted SDK conversations
are created under the repository runtime's private `sdk-sessions/` directory, not mixed into Pi's default
session directory; isolated test runtimes keep their existing private fixture directory. Existing files
are never moved. History combines that owned directory with Pi's default per-worktree discovery, so
older/external conversations remain accessible. External Pi conversations and older records without
provenance are preserved, even if Radian has displayed or resumed them.
Older closed snapshots missing `closedAt` receive a new grace timestamp rather than expiring from
an old checkpoint date. Previously unknown ownership is never inferred from a path or file age.

Each running repository daemon sweeps once in the background after restoring open-session intent,
then once per hour without overlapping runs. Maintenance does not delay the HTTP/TUI handshake;
a stopped daemon catches up at its next startup. `runtime status` reports the active policy and last
successful sweep under `sessionRetention`. The daemon rereads the policy each time. Before deleting a JSONL file it verifies a regular, unchanged
file, its SDK conversation ID and original worktree, then reserves it against Radian resume/create
operations. Files changed externally after the snapshot and symbolic/replaced paths are preserved.
The final file fingerprint is checked again immediately before removal.

Expired owned JSONL and snapshot bodies are removed together. A durable cleanup marker hides a
partially removed conversation from History's JSONL fallback and permits retry after interruption;
small redacted identity markers prevent stale checkpoints from recreating expired bodies. Disabling
new cleanup does not roll back a deletion already started. Permission, corruption or policy failures
remain visible and do not turn into successful empty results. This affects only persisted history;
no model call, extension execution, repository content or current input is replayed by cleanup.

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

History is a searchable popup, not a sidebar tab or a session-toolbar button. Use **`/history`** in
the Agent prompt, or **Ctrl+Space → h** (`history.show`, configurable) from any work view.
Its scope is the active worktree, not the workspace popup's candidate cursor. The list uses SDK conversation
names (falling back to the first prompt or `Untitled session`), last activity and message count,
newest first, including in shared offline directories.

Type a title query, including Unicode text. Every whitespace-separated term must occur as a
contiguous substring; scattered letters do not match. Arrows or Ctrl+N/P move the candidate cursor without
changing the live session; normal letters, including hjkl and r, remain search text. `Tab`/`Shift+Tab`
cycle within the popup. The list additionally supports j/k and Home/End. `Enter` opens the selected
context in Agents, or selects its existing open tab, without copying/forking the SDK file or sending a
prompt. Clicking a row only selects its preview. `Esc` closes the popup and restores its original
focus without changing drafts, transcript scroll, work views, workspace popup visibility or PTY attachments.
Global view/workspace/session commands are inactive while the popup owns focus. Closing a popup while
Open is pending does not cancel or roll back an accepted request; a late result never changes selection.

Wide screens show the list and read-only conversation preview side by side. Below 100 columns,
Ctrl+O switches between them; PageUp/PageDown scroll the preview. Preview reuses the Agent session
panel, including the Prompt composer, run-status row and model/context/usage line, as well as compact
inline invocations, Markdown prose, error styling and initially folded tool sections. Thinking remains
visible just as in the live transcript. The Prompt is visibly read-only: typing and paste do not edit
it, read the OS clipboard or send a request. Session-management controls are hidden.
The transcript retains at most the 15 newest sections of the saved current branch, including earlier
turns, in chronological order, and initially scrolls to the latest content. Completion metadata stays
on its original section rather than moving to a new unanswered prompt; explicit skills remain name-only.
Open sessions supply their current session snapshot. Closed sessions reuse their preserved snapshot,
including execution state, subagent summaries, model, context, Fast and account usage. The header shows
the snapshot's saved time, and closed-session usage/countdowns are rendered as of that time, not as
current account allowance. These values are display-only: SDK resume still resolves current telemetry
and never restores a historical quota or enables Fast from the preview. Only records without a snapshot
fall back to JSONL, where unavailable metadata remains unknown.
Small previews compact composer/status padding to preserve conversation space.
This does not open a writable SDK session, load extensions or execute tools.

Preview lookup has no fixed debounce or preview spinner. The selected title stays visible above a blank
body until its data arrives; another session's content is never shown under the new selection. Each open
popup caches plain Preview data by worktree and saved-session ID, shares in-flight requests, and renders
only the selected entry. Returning to a cached entry does not perform another lookup. At most two queries
run concurrently, with only the latest selected candidate queued when both slots are occupied. Earlier
responses can fill their own cache slots but cannot overwrite a different selected session. Cached data
is bounded to 200 entries / 8 Mi UTF-16 units of serialized text, excluding protected selected/in-flight
entries; these are data-retention limits, not total heap measurements. The cache is a snapshot for the
current popup: Ctrl+R or closing clears it and cancels its queries. Reopening discovers current metadata;
there is no background polling or file watcher. Late responses cannot populate a replacement cache.

History combines the shared snapshot index with SDK-discovered conversations. Snapshots also cover
empty or closed sessions whose SDK file is absent; those records remain previewable but cannot start
a new SDK execution. Preview reads the current or preserved session record and applies its 15-section
and per-body limits only to the response, never to the recovery record. A corrupt snapshot is an explicit
error, not a silent JSONL fallback. Open always rediscovers current membership and writer ownership.

For older/external conversations without a snapshot, the runtime reuses the ID-to-file index from SDK
metadata discovery rather than listing every saved session for each Preview. The selected file's
canonical path, header ID and worktree binding are checked. Cold direct Preview requests lazily
initialize an index. This fallback reader scans JSONL record offsets backwards in 64 KiB chunks and
follows the active branch's parent IDs. It stops once the recent window and required tool-call associations are available, rather
than loading or size-rejecting the entire file. Older unneeded record bodies are not decoded or validated;
opening a closed session still validates the complete history. Safety limits apply to individual records (16 MiB),
the retained association working set (32 MiB), header size (64 KiB) and lookup time (5 seconds), not
total file size. If an older record exceeds the record/working-set budget after a recent turn has been
reconstructed, the reader returns that safe tail with an explicit truncation notice. Each returned section body is capped at 8,192 UTF-16
units with an explicit truncation notice; the compatibility text field remains capped at 65,536 units. The title query searches all returned metadata locally; at most 200
matching rows render at once, with a prompt to refine larger result sets. Full-message search is not
implemented. Ctrl+R refreshes metadata and Preview data (`r` also works while the list has focus).
Only the metadata list uses a loading spinner: it remains visible for at least 500 ms without delaying
results or errors, and cancels on close/disposal. Preview failures remain visible until refresh.
Empty history, no matches, discovery failures, preview failures and Open failures remain distinct.

Closing records and active owned-child writers cannot be opened until cleanup finishes. Completed
SDK child conversations can appear in history. The shared retention policy applies only to expired,
closed records with confirmed Radian ownership; external and legacy conversations remain visible.
The workspace search remains exclusively the workspace-name projection. A worktree change closes an
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

### Search matching

App-owned search uses shared, UI-independent matching with NFKC Unicode normalization and
case-insensitive comparison. It does not use fuzzy matching. Commands, prompt templates and Skills
match name prefixes. File completion matches literal path substrings, preserving query whitespace.
Workspace, History, session monitor, model, Refs and Reflog searches require every whitespace-separated
term as a contiguous substring, regardless of term order. Empty general queries show all eligible
candidates. Each feature retains its searchable fields, domain ordering, selection and display limits;
matching never rewrites original names or paths.

### Workspace search

Open the workspace popup with `Ctrl+f` outside a PTY or leader w/f/b from any view.
Results update while typing, deleting or pasting. Matching is normalized, case-insensitive substring
search over repository names, worktree folder names and actual branch names. Every query term must
match within the same name or branch field. Repository matches retain their worktrees.
Session/subagent titles, paths and history are not searched.
`Ctrl+N/P` move candidates in both search and tree focus without changing the active workspace;
Tab switches to the tree for j/k and Home/End. `/` returns from the tree to search. **Enter from either surface opens the candidate.**
`Ctrl+C` clears the query; it never closes the popup or interrupts the Agent.
From search, `Ctrl+D/U` transfers focus to results and jumps the current
candidate by half a viewport without editing the query. **Esc closes**, preserving the query and cursor for reopening.
Filtering and host updates never change canonical selection or start a repository service.

### Session monitoring

**Leader s** opens all working sessions and unread results across already-connected repository
services. Needs-attention candidates come first; sessions with running owned subagents remain
included even if another child failed. Subagents belong to their main session, not independent
navigation destinations. Search matches delivered-request summaries, repositories, worktrees and
branches. Candidate identity is retained during streaming and status updates. Rendering is capped
at 200 matches with an explicit refine-search notice; search still covers all session summaries.

The right-hand pane previews the selected conversation without marking it as read. Like History,
preview is bounded to six sections / 8,192 text units each; open the session for full content.
At narrow widths, **Ctrl+O** toggles the list and preview; PgUp/PgDn scroll preview. Preview rendering
and loading animation stop when hidden. The monitor never polls processes, rescans session files,
queries models or starts cold repository services. It projects in-memory session summaries in linear
time and renders only the selected preview. Full-snapshot transport/parsing remains an existing
cost, separate from this summary projection.

**Enter** opens the actual session in Agents, reveals its latest output and focuses the input so you
can continue the conversation immediately. A foreground Agent conversation acknowledges a pending
result only while its latest output is actually visible, not while scrolled into older output,
covered by a popup or in another work view. Merely restoring a selection, browsing preview or
receiving a background snapshot does not acknowledge it.

Completion, failure, unfinished (`Stopped`) and unknown-origin cancellation create unread results.
Explicit user interruption and lifecycle shutdown do not create another alert or erase a previous
unread result. Each result has an identity: delayed acknowledgements cannot clear a newer result
or a replacement conversation. Read state is runtime-owned, shared by attached TUIs and saved in
checkpoints, including work completed while detached. Reopening History does not replay old alerts.
Restoring a previously running job after runtime termination produces a stopped result, not success.

The additive `session-attention` capability is required for unread tracking. Legacy services still
supply working sessions; the monitor explains the missing support. Finish work and explicitly
restart old services to upgrade. No service is automatically restarted.

### Display status

Repository and worktree rows retain their Nerd Font type icons and a fixed error slot.
Session tabs display **at most one icon in one cell**, in this priority order: **working spinner >
failure glyph > stopped `?` > unread bell**. Main-agent or owned-child work takes precedence even
when an earlier result is unread or another child failed. Successful completion has **no check icon**.
Unread state remains independent of execution status and is retained when a higher-priority icon
hides the orange bell; the session monitor still lists that unread result. Acknowledging a result
never changes its execution outcome. Stopped `?` and failure glyphs remain after acknowledgement.
`Stopped` uses warning-colored text above input as well. Terminal warning color normally comes
from ANSI slot 3 (fallback `#E5C07B`); the `attention` role defaults to `#E9953A` and can be overridden
globally or through `status.attention`.
A settled icon replaces and cancels the hidden spinner immediately, rather than displaying beside
its 500 ms minimum tail. Without a replacement icon the shared spinner retains its minimum-visible
tail before collapsing. Empty indicator cells and their gap are reclaimed for the ID. Hidden views
cancel animations. Each tab retains its one-cell outer padding. Selection and focus never change
the underlying execution outcome.

The work-status row shows the selected session's run state and its subagent counts at the right
edge. The counts remain independent of the parent run's settled outcome. Working, failure, complete
and unknown counts use reserved widths; narrow panels omit less urgent counts or shorten the prefix
without adding rows. Counts only include runtime-owned children already supplied by the snapshot,
not arbitrary extension-managed processes. Transcript `Paused` appears in the footer, not this
execution row. Model/context/account usage remains on the separate lower telemetry row.

The SDK adapter normalizes events into display snapshots. `agent_end` alone is not completion:
automatic retries keep the run working, and `agent_settled` plus the final outcome determine
completion/failure. Aborted or unreported outcomes never imply success or a guessed idle state.
Unknown-origin cancellation can still need attention, while intentional interruption has no new
notification icon. `Stopped` means settlement without a confirmed success, failure or cancellation;
it is not a pause/resume state and is unrelated to the model's normal `stop` finish reason.

Use a Nerd Font-enabled terminal to view the glyphs. Current mappings are `nf-cod-repo`
(U+EA62), `nf-cod-folder` (U+EA83), filled `nf-fa-bell` (U+F0F3), `nf-cod-close` (U+EA76),
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
| `src/app/ui/workbench.ts` | Overall layout, workspace popup, view switching, focus, acknowledgement and footer coordination |
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

This project is licensed under the [MIT License](../LICENSE).
