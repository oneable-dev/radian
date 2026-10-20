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
They share a single horizontal text viewport: scrolling over either line moves both by the same
offset, while a fixed one-cell error slot stays visible. Metadata updates preserve that offset;
resizing or shortening the labels clamps it to the valid range. The sidebar has no execution
spinner; failures remain visible without animation. Agent tabs and the work-status row retain
their execution indicators.
Repository groups, headers and worktree labels have one separation row between them,
while folder/branch lines stay together. A thin selection frame uses the rows above and below its
labels. Worktree items keep the panel background even when selected; only the border and text are
emphasized. Adjacent items share that separation row, preserving the existing text spacing; hidden
frames reserve the same space so selection never moves or resizes items. The navigation cursor has
the frame while the tree is focused; otherwise the active worktree keeps it. Selected text and border
colors stay the same when focus moves elsewhere.
These vertical gaps do not change with terminal height; there is no compact-layout mode.
The workspace search surface spans the sidebar width with three rows and centered single-line
input at every terminal height; narrow terminals use a shorter placeholder.
The padded search area is clickable and preserves its query and cursor across resize/collapse.
Use `Tab`/`Shift+Tab` to move focus. `j/k`, arrows and Home/End move the tree cursor
without changing the current workspace; **Enter** opens the highlighted worktree and restores its
last work view/session. Mouse clicks open a worktree directly. Open sessions are tabs within Agents;
focus that strip to use `h/l` (or left/right), Home/End, `n` for new and `x` for close.
`Ctrl+e` focuses the session prompt; `Enter` submits, `Shift+Enter` or `Alt+Enter` inserts a newline,
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

Commander handles options, help, version and repository-scoped runtime commands:

```sh
bun run start --help
bun run start --version
bun run start --demo
bun run start --no-color
bun run start runtime status
bun run start runtime stop
```

Help/version and invalid arguments are handled before SDK/resource initialization, configuration
reads, workspace discovery or service activation. Interactive mode requires TTY stdin/stdout and a
cursor-addressable UTF-8 terminal; pipes and `TERM=dumb` receive plain guidance instead of fullscreen
escape sequences. Runtime commands remain usable without a TTY and ignore workspace-root discovery.
`runtime stop` is explicit and closes the selected repository service's owned agents, editors and shells;
save work first. The existing `--runtime-status` and `--stop-runtime` aliases remain accepted.
Internal service flags and isolated `--test-runtime` startup remain compatible.

`--no-color` or a nonempty `NO_COLOR` uses terminal-default foreground/background with existing
bold/underline and reverse selection emphasis. It does not merely replace colors with gray RGB
escapes. Provider icons use the text fallback and branding omits its color fade. Embedded programs'
configuration remains untouched; only the attached UI's final frame is rendered without color.
The normal colored UI continues to follow the host palette. `--runtime-cwd` chooses the repository
for administrative commands; a relative `--state-dir` is resolved once against the launching directory.
`--workspace-config`, `--keybindings` and `--theme` continue selecting explicit configuration files.

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

Worktrees within discovered repositories update automatically. Native filesystem watches observe
Git's canonical common directory and linked-worktree registration metadata, including the first
creation or replacement of the `worktrees` directory. Events are debounced for 250 ms, then Git's
worktree list is reread; there is no periodic workspace scan or polling loop. Repository services
own their watches, while the TUI watches cold repositories without starting their services and
hands ownership over on activation. Agent sessions, History, Editor and Terminal share the updated
catalog. Existing sessions, drafts and selection survive refresh; removed worktrees with open
resources remain listed until those resources are released. Failed scans retain the last valid
list and expose a notice. Services that were started before this feature was installed need a
one-time restart to load it; reopening only the TUI does not replace an existing service.

The TUI attaches to already-running repository services without restarting them. A cold repository's
service starts only when that repository is selected or explicitly used, not once per scan result.
The launching repository is preferred initially when present, otherwise the first discovered repo.
Prompts, History, editors, terminals and preference writes route to their owning repository service.
Drafts, selected sessions and view state survive lazy attachment; detaching releases this TUI's
connections, not the underlying agents or native processes.

### Work views

The left panel starts directly with search and workspace navigation, without a tab heading.
The right panel switches between **Agents**,
**Editor**, **Git** and **Terminal**, with one visible view per worktree and Agents as the initial view.
Tree cursor movement is only navigation; Enter or a direct worktree click commits the selection.
Each worktree separately remembers its work view and selected Agent session. Within Agents, session
tabs show their session ID and aggregate status, with a close control. IDs remain complete whenever
they fit the available strip width; narrower tabs truncate only at the end with `…`, never in the
middle. There is no fixed label-length cap, and widening the pane restores the full ID. Session names
remain unchanged for History and other metadata. Focus the strip and press `n`
(or the configured `session.new` key) to add a session; the strip remains focusable when empty.
The upper-right worktree label and the New session/History toolbar buttons are removed. Session-tab selection and History resume open the chosen session in Agents. Restoring a
selection, filtering and background snapshots never implicitly activate another work view.
Session creation/closing retain their existing rules and never implicitly launch an editor.

**Ctrl+Space, then b** toggles the entire left panel closed and open, without an extra toolbar button.
Opening also focuses the workspace tree; closing returns sidebar focus to the work area.
Esc in the Agent prompt no longer moves focus to the sidebar.
The work pane takes the freed width without recreating Agent, Editor or Terminal instances.
Selection, drafts, transcript positions and loaded History rows are retained. In a connected Editor,
a sidebar toggle prepares the target PTY size while retaining the existing layout, then presents the
new layout and matching newer VT snapshot together. Rapid toggles retain the latest intent without
restarting Neovim; stale sizes cannot overwrite the visible VT. Focus/search commands still reveal
the panel immediately so subsequent typing reaches the requested control; hidden navigation controls
are excluded from Tab traversal. Editor PTYs retain the previous snapshot until new process output
arrives rather than publishing emulator-only resize state. That runtime-side safeguard requires an
updated service; existing services are never restarted automatically.
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
information, with Copy and Remove actions. Pasted text shows its original contents; image/file
items show their source references, not rendered image thumbnails.

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
suggestions only in the first token at the beginning of the prompt. `@` opens file suggestions at
the beginning of any whitespace-delimited token, including in the middle of a sentence; email
addresses do not trigger it. Matching uses the text before the cursor, not just the end of the draft.
Lookups use a **150 ms trailing debounce**; input, cursor movement and candidate navigation remain
immediate. During refresh the previous candidates and selection stay visible, and the open menu
reserves a stable bounded height, including for loading, errors and no matches. Stale candidates
cannot be inserted until results for the current query arrive. Footer shortcuts retain their positions
and unavailable actions use muted keys instead of disappearing.

- **Ctrl+N / Ctrl+P** selects the next/previous candidate. `hjkl` remains ordinary input.
- **Tab** inserts the selected candidate without sending the prompt or executing a command.
- **Enter** completes the focused command, template or Skill candidate and immediately submits it
  in one key press: `/com` with `/compact` focused runs `/compact`, not `/com`. Existing arguments
  are preserved, and immediate execution adds no trailing completion space. If a focused command is
  being refreshed, Enter waits for fresh results; editing, dismissing, switching sessions or a changed
  selection cancels that pending submission rather than executing stale or incomplete input.
- With no focused command candidate, **Enter** submits the current input as written. File suggestions
  still require **Tab** for insertion. **Esc** dismisses only the menu and preserves focus/text.
- Selection replaces only the current token, preserving the surrounding text and native Unicode cursor.
  Selected files appear as numbered file/image items rather than exposing long paths in the editor.
  Ordinary file references retain their absolute paths for tool access; images use the image transport.

Command candidates come from the selected SDK session's registered extension commands, prompt
templates and enabled Skill commands, together with Radian's host commands. `/model` opens Radian's
native model picker; Pi CLI-only commands such as `/settings` are not advertised as implemented.
Pi's interactive dialogs/custom terminal components are not embedded.
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

The former `INPUT · section/count · following` row is removed. Source/Visual/help mode and a
`Paused` indicator appear only when relevant in the one-row footer; `Paused` refers to viewport
following, never agent execution. Following is based on the viewport: at the bottom it follows new output; moving above the bottom pauses it;
returning to the bottom by wheel, scrollbar or paging resumes it automatically. Merely focusing the
transcript does not pause it. Content growth and asynchronous Markdown layout preserve the pre-growth
bottom intent rather than treating the increased scroll range as user navigation. Following also
keeps the bottom on resize and when returning from another work view.

Above the bottom, a centered `↓ Back to bottom` button uses an existing blank row above the work
status or in the composer's top inset. It never adds blank rows, covers transcript content or moves
the input. It shows the effective `transcript.latest` shortcut (default `g → e`); clicking resumes
following without sending a prompt or taking input focus. It is hidden at the bottom, in help/history
previews and whenever no existing blank row is available.

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

After a non-cancelled run actually settles, its final displayed section has a gray footer such as
`Worked for 1m 30s • Sep 19 at 10:55 AM`, followed by a separate request line such as `“Review tab icons”`.
Request text uses the same quotation marks as `Working`; attachment badges stay outside them.
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

- **`/model`** opens a searchable model popup for the **current session**. Models come from Pi's
  authenticated chat-model catalog, including configured and extension-provided models. Search by
  model name, ID or provider; use arrows or Ctrl+N/P to move, Enter or a model click to apply, and Esc
  to close without changing the model. The current model is marked. Changes preserve the conversation,
  update the input telemetry and use Pi's SDK model/thinking-level lifecycle. The selection is saved
  in that conversation for resume, never as the global default or another tab's model. No model prompt
  is sent by lookup or selection. Busy sessions reject switching without interrupting running work.
  The additive `model-selection` service capability is required; older services report an explicit
  upgrade notice and are never automatically restarted. The command takes no arguments or images.
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
- **`/compact [instructions]`** invokes Pi's manual context summarization for the current conversation.
  It may make summarization model calls and consume quota. It keeps the tab, saved conversation
  and full displayed transcript; only the model context is compacted. During compaction the work-status
  row shows `Compacting context…` and a spinner instead of the previous request. On success the progress
  label disappears and the resulting `Context compacted` section starts folded. The session
  must be idle: running/queued input, compaction and owned work cause an explicit busy rejection,
  without interruption. Empty or too-small context is rejected without a model request.

These commands do not accept image attachments; `/new` and `/clear` take no arguments. Rejected commands retain
input. Accepted long-running actions report progress; acknowledgement is not completion. A valid
compaction failure belongs to that conversation rather than a second global error notification.
`/clear` resets that tab's transcript navigation. `/new` preserves the outgoing tab's navigation,
selection and scroll position. Both preserve input edited while acknowledgement is pending.
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
Both meters use the same block-bar style. A provider icon identifies the account meter; `18% used 1h 20m` means consumption followed by
time until reset, without a middle-dot separator. Reset times use `5d 23h`, `1h 20m` or `18m`. The compact meter selects the longest returned
quota window; all returned windows remain available in the IPC snapshot. There is no refresh button.

Filled bar cells fade from the terminal's accent toward the panel color; empty cells stay subdued.
Context labels and known values use the same foreground as account usage. Model names use the theme's
number (yellow/gold) color, effort uses keyword, and `fast` uses success when on or info when off; unknown values
and separators stay muted. These are terminal palette roles, not fixed product colors.
The prompt surface reaches both edges of the Agent pane; its internal padding aligns the editable
text with the work-status and telemetry rows. The sidebar divider sits at the right edge of its
character cell, avoiding a half-cell gap beside the prompt surface. The empty prompt has no marker or placeholder,
and focusing it keeps the same surface background; the caret and left border indicate focus.
The transcript, optional single-line work-status row and input group use a one-row parent gap;
neither the transcript end nor work-status row adds its own boundary padding. Pending messages,
the composer, completion candidates and padded telemetry remain adjacent inside the input group.
Constrained windows retain usable input and conversation space before adding boundary gaps or
prompt padding. The lower telemetry keeps its one-row gutters. A temporary
zero-height conversation viewport is hidden rather than painting over adjacent controls, and
closing completion restores its position. Narrow panels shorten bars and omit settings or the
countdown before dropping either resource percentage. Theme changes preserve the current draft and focus.

Provider logos reserve two columns. On terminals reporting Kitty/Sixel graphics and pixel resolution,
OpenTUI renders a font-derived, theme-tinted image with approximately 1.5x the ordinary glyph width,
within the same row. Other terminals retain a bold Nerd Font glyph; individual character scaling is
not assumed. No terminal font settings are changed. Asset attribution is in
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

Radian-owned view and filter tabs use underlines for active selection and keyboard focus, without
a background fill. This includes the top-level Agents/Editor/Git/Terminal tabs and Git's
Commits/Reflog, Commit/Refs and Local/Remote/Tags tabs. Agent and Terminal session tabs use background emphasis without
underlines; an unfocused active session keeps a subdued background. Other buttons retain their
usual focus styling. Navigation uses understated separators rather than boxed controls.
Sidebar, work-view content and footer text use two-cell horizontal insets, reduced to one on terminals
narrower than 80 columns. The workspace scrollbar always leaves one cell before the sidebar divider,
without changing the sidebar's left inset or width. Main work tabs leave a single blank row before their content at every
terminal height. Tabs, search surfaces and item gaps no longer switch height modes. The composer
retains its normal vertical padding unless fixed controls need that space. Work surfaces have no
additional top or bottom panel inset. Routine Neovim/worktree captions, the `Git · … · All refs` line
and the terminal `… · running` line are omitted; empty, error, exit and reconnect messages remain meaningful.
Agent's padded telemetry, Editor, Git lists/diffs and Terminal end at the same bottom edge as the sidebar
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
Ctrl+C clears drafts in Agent input; in Editor and Terminal, Neovim and shells still receive it as native input.
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
`git`, `git-prompt`, `dialog`, or `none`. An override replaces that command's defaults;
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
strips and read-only dialogs. Horizontal navigation/reveal remains enabled where needed; vertical
scrollbars, Git diff movement and embedded programs' own UI/configuration are unchanged.

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

A workspace snapshot includes every retained session, not one prompt or one terminal viewport.
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

History is a searchable popup, not a sidebar tab or a session-toolbar button. Use **Ctrl+Space → h**
(`history.show`, configurable) from any work view. Its scope is the active worktree, not the
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
badge, independently of the spinner's minimum-visible tail. Each session tab has one cell of padding
at both ends. Working and settled status glyphs share the leading badge cell; a remaining spinner tail
uses the second cell without shifting the title or close control. Hidden views cancel their animations.
Selection and focus do not change execution status.

The work-status row shows the selected session's run state and its subagent counts at the right
edge. The counts remain independent of the parent run's settled outcome. Working, failure, complete
and unknown counts use reserved widths; narrow panels omit less urgent counts or shorten the prefix
without adding rows. Counts only include runtime-owned children already supplied by the snapshot,
not arbitrary extension-managed processes. Transcript `Paused` appears in the footer, not this
execution row. Model/context/account usage remains on the separate lower telemetry row.

The SDK adapter normalizes events into display snapshots. `agent_end` alone is not completion:
automatic retries keep the run working, and `agent_settled` plus the final outcome determine
completion/failure. Aborted or unreported outcomes show no session-tab status badge or extra gap,
never implying successful completion or a guessed idle/waiting state. Once any spinner tail ends,
the unused badge cells are reclaimed for the session ID; the tab keeps its normal one-cell outer
padding. Reported outcomes retain their badge alignment. Additional idle/waiting/cancelled icon
policies are not defined here.

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
