Use English for repository documentation and commit messages.

## Error handling

- Return `Result<T, E>` with custom error types and stable codes for expected domain, I/O, cancellation and protocol failures. Callers must explicitly handle both branches.
- Keep unexpected programming errors as exceptions with their original cause and stack; log them at host/UI boundaries, not as ordinary input errors.
- Limit `try/catch` to exception-based SDK/OS boundaries and cleanup. Do not classify errors by message text or silently turn all failures into empty values.
- Distinguish an accepted action with a persistence warning from a rejected action. A timeout does not prove cancellation or rollback.
- Convert a failed Result to rejection only at boundaries whose contract requires exceptions (for example Pi SDK tool execution).
