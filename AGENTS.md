Use English for repository documentation and commit messages.

## UI feedback

- Use `LoadingSpinner` from `src/ui/loading-spinner.ts` for loading indicators across the UI. It keeps the animation visible for at least 500 ms without delaying results or errors. Call `cancel()` when the owning screen is hidden; destroying its renderable also clears its timers.

## Keyboard navigation

- Arrow keys and `Ctrl+N/P` are required defaults throughout app-owned navigable UI. `Ctrl+N` moves down/next and `Ctrl+P` moves up/previous as appropriate to the surface. Keep both input styles available; `Ctrl+N/P` is not merely a fallback when Vim keys are unavailable.
- Additionally support the applicable `h/j/k/l` navigation keys wherever practical. Do not force them where they conflict with text input, existing key semantics or native input ownership.
- In scrollable or paged views, provide jump navigation such as `Ctrl+D/U` for half-page down/up wherever practical. In candidate lists, jump the candidate cursor by half a viewport of items; in read-only bodies, scroll the focused body. From a search input, `Ctrl+D/U` must preserve the query and caret, move focus to the results list and perform the candidate jump from the current selection. Further presses and held-key repeats continue list navigation; do not replay the same event as native editing after focus changes. In compact layouts, reveal the results list before handing off focus. `Ctrl+C` alone clears the search query, consistent with Agent draft clearing; do not bind `Ctrl+L` as an alias. An empty query makes this a no-op: do not close the popup, detach the app, interrupt work or clear the Agent draft. Consume held clear-key repeats until release even if focus changes. Ordinary prompts and native PTYs retain their own editing behavior.
- Searchable lists must support `Ctrl+N/P` in both search-input and results-list focus; offer `j/k` in results lists where practical. These keys move the candidate cursor one item at a time, not the raw scroll position. Keep the candidate visibly highlighted even while search retains input focus; adjust the viewport only as needed to reveal an off-screen candidate. Do not let navigation disappear when focus moves within a popup.
- Tab strips support Left/Right and `Ctrl+N/P` in their own focus context, with `h/l` where practical. Keep repeated navigation within the strip instead of moving focus into its content after one key.
- Active completion menus support Up/Down and `Ctrl+N/P`; after dismissal, restore ordinary input editing.
- Keep unmodified `h/j/k/l` literal in text inputs and preserve native input ownership in embedded editors and terminals. Respect explicit user keybinding overrides.
- Omit bare arrow-key navigation from shortcut hints and help; show the actual configured alternative keys instead. Modified arrow keys and multi-key sequences remain meaningful shortcuts.
- Cover navigation across search/results focus, text-input preservation and shortcut hints with regression tests when changing these surfaces.

## Error handling

- Return `Result<T, E>` with custom error types and stable codes for expected domain, I/O, cancellation and protocol failures. Callers must explicitly handle both branches.
- Keep unexpected programming errors as exceptions with their original cause and stack; log them at host/UI boundaries, not as ordinary input errors.
- Limit `try/catch` to exception-based SDK/OS boundaries and cleanup. Do not classify errors by message text or silently turn all failures into empty values.
- Distinguish an accepted action with a persistence warning from a rejected action. A timeout does not prove cancellation or rollback.
- Convert a failed Result to rejection only at boundaries whose contract requires exceptions (for example Pi SDK tool execution).
