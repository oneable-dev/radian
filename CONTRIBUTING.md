# Contributing

Use the Bun version declared in `package.json` and install dependencies with:

```sh
bun install --frozen-lockfile
```

## Checks

```sh
bun fmt --check
bun lint
bun run typecheck
bun test
```

Use `bun fmt` to apply Bun's built-in formatting. `.oxfmtrc.json` is retained for
Oxfmt compatibility: it uses a 100-column print width, preserves import and
`package.json` key order, and excludes generated output and dependencies. The
`format` and `format:check` scripts delegate to `bun fmt` and `bun fmt --check`.

Bun 1.4.4 includes `bun fmt`, but not a built-in `bun lint`. `bun lint` therefore
still runs the project's Oxlint script. Keep `oxlint` and `oxlint-tsgolint` until
a stable Bun release includes the native linter and its checks have been verified.

`bun lint` runs Oxlint's correctness rules and type-aware checks, including
`typescript/no-floating-promises`. Errors, warnings, and unused suppression
comments fail the check. Generated output and dependencies are excluded in
`.oxlintrc.json`.

Use `bun lint --fix` for automatic fixes, then review the diff and rerun the
checks. The `lint:fix` script remains available too. Do not apply dangerous fixes
or reformat unrelated code as part of lint cleanup.

Handle promises with `await`, `return`, or a rejection handler. The default
`no-floating-promises` options allow an explicit `void` for intentionally detached
work, but `void` does not handle failures: report unexpected rejections at the
owning host or UI boundary.

Two type-aware rules are disabled only in `*.test.ts` files:

- `await-thenable`: Bun's async `.resolves` and `.rejects` matchers are declared as
  returning `void`; their assertions must still be awaited.
- `unbound-method`: tests inspect spies and mock methods without calling them as
  detached functions.

Keep other intentional exceptions local with an `oxlint-disable-next-line`
comment explaining the behavior being preserved. In particular, terminal
control-character sanitizers, snapshot iteration over mutable collections, and
native accessor side effects must not be removed just to satisfy a lint rule.
