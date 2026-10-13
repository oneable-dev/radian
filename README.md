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

The demo displays `Hello, Radian!`. Press `q`, `Esc`, or `Ctrl+C` to quit.
The Pi SDK is installed for future integration; this demo does not make model requests or require API keys.

```sh
bun run dev        # Run the TUI during development
bun run typecheck  # Check TypeScript types
```

## Repository

https://github.com/oneable-dev/radian

## License

This project is licensed under the [MIT License](LICENSE).
