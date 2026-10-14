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

The UI preview discovers the current Git repository's worktrees and shows an always-expanded
workspace sidebar. Worktree folders and branches share one row. Press `Ctrl+C` to quit.
Use `Tab`/`Shift+Tab` to move focus, arrow keys to select tree items, `n` to request a new
session, and `x` to request closing the selected session while the tree is focused.
Mouse selection and close actions are also supported.

```sh
bun run start --demo  # Display fixture sessions/subagents and exercise selection and closing
```

**This is a UI-only preview.** Default mode has no open sessions; `--demo` uses display-only
fixtures. Closing a demo item removes only its in-memory display metadata. New-session actions
report the request without creating an agent or changing selection. The Pi SDK is not invoked;
no model requests, credentials, saved sessions, or runtime lifecycle operations are involved.
History and the full editor/inspector remain deferred.

```sh
bun run dev        # Run the TUI during development
bun run typecheck  # Check TypeScript types
bun run test       # Run unit and OpenTUI headless interaction tests
```

## Repository

https://github.com/oneable-dev/radian

## License

This project is licensed under the [MIT License](LICENSE).
