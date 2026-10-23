<h1 align="center">radian</h1>

<p align="center">
  <strong>A keyboard-first AI workbench for your terminal.</strong><br>
  Pi agents, your Neovim setup, Git, and terminals — organized by worktree.
</p>

<p align="center">
  <a href="#getting-started">Get started</a> ·
  <a href="#keybindings">Keybindings</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.4.3-7DD3FC?style=flat-square" alt="Bun ≥ 1.4.3"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7DD3FC?style=flat-square" alt="MIT license"></a>
</p>

<!-- Release media: add a real Agent-view screenshot here, followed by a short
workflow demo: Agents → Neovim → Git → another worktree → the running Agent.
Keep font size, terminal dimensions, and theme consistent. -->

Radian is a standalone terminal application, not a Neovim plugin or distribution.
Work with Pi Agent, edit with your existing Neovim configuration, review changes,
and run shells without leaving your workbench.

> [!NOTE]
> Radian is in early development and currently runs from source. Interfaces and
> runtime behavior may change before the first release.

## Why Radian?

- **Your Neovim, unchanged.** Bring your own configuration and plugins. Radian
  embeds Neovim rather than replacing your editing environment.
- **Worktree-native.** Keep agent sessions, drafts, editor state, and terminals
  scoped to the worktree they belong to.
- **Keep work running.** Detach the interface and reconnect while the local runtime
  stays alive. Switching views or worktrees does not stop your agents or shells.
- **Review, then ask.** Browse Git history and whole-file diffs, then attach Git
  context to an agent prompt without leaving the Git view.
- **Commands over chrome.** Use configurable leader sequences, searchable lists,
  and familiar motions instead of permanent sidebars and toolbars.

## One workbench, four views

Each view gets the work pane to itself. Workspace navigation opens as a searchable
popup, so switching projects does not take space away from your editor or terminal.

| View | What you can do |
| --- | --- |
| **Agents** | Run independent Pi sessions, read tool output, switch models, and resume saved conversations. |
| **Editor** | Use your own Neovim, with its buffers, cursor, and editing state retained while the runtime stays alive. |
| **Git** | Browse commits, refs, reflog, and working-tree changes in a read-only interface. |
| **Terminal** | Run worktree-local shells and development servers that keep running when you detach. |

## Requirements

- **macOS or Linux** for the local runtime and embedded terminals.
- **Bun ≥ 1.4.3** and **Git** on your `PATH`.
- A cursor-addressable **UTF-8 terminal** with interactive stdin/stdout.
- **Neovim** available as `nvim` on the runtime's `PATH` to use Editor.
- A **Nerd Font** is recommended for the full icon set.
- Provider authentication is needed for real model requests; it is not needed for
  the display-only demo.

## Getting started

### Run from source

```sh
git clone https://github.com/oneable-dev/radian.git
cd radian
bun install --frozen-lockfile
```

Preview the interface without credentials or model calls:

```sh
bun run start --demo
```

Demo sessions are display fixtures, not real agent conversations. To start working:

```sh
bun run start
```

By default, Radian discovers Git repositories under `~/projects` and `~/.dotfiles`,
including their linked worktrees. If your projects live elsewhere, set your
[workspace roots](#configuration) before launching.

### Start your first session

The default `<leader>` is `<C-Space>`: press and release Ctrl+Space, then press the
next key.

1. Press `<leader>f` to find a repository or worktree, then `<CR>` to open it.
2. In Agents, press `<leader>n` to create a session.
3. Run `/accounts` to add and select a provider account, or reuse existing Pi
   authentication. Adding an account does not activate it; select it explicitly.
4. Run `/model` to choose the session's model and supported reasoning effort.
5. Write a request and press `<CR>`. Use `<S-CR>` or `<M-CR>` for a newline.

> [!WARNING]
> Real agent requests can use provider quota and run coding tools in the selected
> worktree. Radian is not a filesystem or process sandbox.

Use `<leader>e`, `<leader>g`, and `<leader>t` to move between editing, reviewing, and
shell work. Press `<leader>a` to return to Agents.

### Leave without stopping work

Press `<leader>c` to detach only the interface. Run `bun run start` again from the
Radian checkout to reconnect to the same live runtime.

To inspect or explicitly stop the shared runtime:

```sh
bun run start runtime status
bun run start runtime stop
```

**Stopping the runtime is not detaching.** It shuts down its agents, editors, and
shells across all registered repositories. Save editor buffers and finish important
jobs first. A stopped runtime does not preserve live Neovim buffers or shell processes.

## Keybindings

These are defaults; commands can be remapped or disabled. `<leader>` is `<C-Space>`
unless you configure another sequence.

| Keys | Action |
| --- | --- |
| `<leader>a` / `e` / `g` / `t` | Select Agents / Editor / Git / Terminal. |
| `<leader>f` | Search repositories and worktrees. |
| `<leader>n` | Create an agent session or terminal in the current view. |
| `<leader>1` … `<leader>9` | Select an agent session or terminal tab by position. |
| `<leader>h` | Open saved agent history for the current worktree. |
| `<leader>s` | Monitor agent sessions. |
| `<leader>[` | Read and select output in Agents or Terminal. |
| `<leader>c` | Detach the interface; keep the runtime running. |
| `<leader>?` | Open keyboard help. |

App-owned lists support `<C-n>` / `<C-p>` for next/previous and `<C-d>` / `<C-u>` for
half-page navigation. Search inputs keep `h/j/k/l` as literal text; results lists
support applicable Vim motions. Embedded Neovim and shells retain their native
input behavior except for configured application shortcuts.

In the Agent prompt, `<C-c>` clears the draft; it does not interrupt work. `<Esc>`
interrupts the selected agent, or interrupts and sends its queued messages when
present. An open completion menu consumes the first `<Esc>` to dismiss itself.

See the [full keybinding reference](docs/reference.md#keybindings) for scopes,
custom mappings, and input ownership. If macOS reserves Ctrl+Space for input-source
switching, change that system shortcut or Radian's leader.

## Configuration

Radian follows the host terminal's palette by default. Optional settings live at
`${XDG_CONFIG_HOME:-~/.config}/radian/settings.json`:

```json
{
  "workspace": {
    "roots": ["~/projects", "~/.dotfiles"],
    "maxDepth": 4
  },
  "keybindings": {
    "leader": "ctrl+space"
  },
  "theme": {
    "accent": "#7DD3FC"
  }
}
```

Set `workspace.roots` to your project directories, or use `[]` to scope discovery
to the Git repository containing the launching directory. Relative roots resolve
against the settings file's directory. Reopen the interface after changing these
settings; running jobs do not need to stop.

Use `bun run start --config /path/to/settings.json` for a separate settings file.
Provider credentials and Pi session settings are managed separately.

## Documentation

The [reference guide](docs/reference.md) preserves the detailed behavior and
implementation notes, including:

| Topic | Reference |
| --- | --- |
| Workspaces and views | [Discovery](docs/reference.md#workspace-roots) · [Work views](docs/reference.md#work-views) |
| Agent workflows | [Commands](docs/reference.md#agent-session-commands) · [Transcript](docs/reference.md#agent-transcript) · [Completion](docs/reference.md#prompt-completion) |
| Git and shells | [Git](docs/reference.md#native-git) · [Terminals](docs/reference.md#terminal-tabs) |
| Personalization | [Settings](docs/reference.md#unified-settings) · [Theme](docs/reference.md#theme) · [Keybindings](docs/reference.md#keybindings) |
| Persistence and recovery | [Service lifetime](docs/reference.md#service-lifetime-and-recovery) · [Session retention](docs/reference.md#session-retention) |
| Development | [Source organization](docs/reference.md#source-organization) · [Error contracts](docs/reference.md#error-contracts) |

## Current scope

- Git browsing is **read-only**: staging, commits, branch switching, and conflict
  resolution are not built into the Git view.
- Live editor and terminal state survives interface detach, not runtime shutdown.
  Recovery does not replay shell commands or interrupted agent requests.
- Pi skills, prompt templates, and SDK-compatible extensions can be discovered;
  Pi's interactive CLI dialogs and custom terminal components are not embedded.
- Native Windows is not currently supported by the local runtime.

## Development

```sh
bun run typecheck
bun test
```

Tests that exercise embedded Neovim also require `nvim`. See the
[reference guide](docs/reference.md#test-real-sdk-switching-without-a-paid-model)
for the isolated, scripted SDK/worktree fixture.

Bug reports and focused contributions are welcome via
[issues](https://github.com/oneable-dev/radian/issues) and pull requests.

## License

[MIT](LICENSE).
