import { createTwoFilesPatch } from "diff";
import { GitError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";
import type { GitComparison } from "./model.ts";

export function fullFilePatch(comparison: GitComparison): Result<string, GitError> {
  const { before, after } = comparison;
  if (!before && !after) {
    return ok("");
  }
  // jsdiff intentionally emits no hunks for equal files. A context-only hunk keeps
  // pure renames/mode changes navigable without inventing a content modification.
  if (before === after) {
    const lines = before.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    return ok(
      [
        "--- Before",
        "+++ After",
        `@@ -1,${lines.length} +1,${lines.length} @@`,
        ...lines.map((line) => ` ${line}`),
        ...(!before.endsWith("\n") ? ["\\ No newline at end of file"] : []),
        "",
      ].join("\n"),
    );
  }

  const patch = createTwoFilesPatch("Before", "After", before, after, undefined, undefined, {
    context: Infinity,
    timeout: 150,
    maxEditLength: 40000,
  });

  return patch === undefined
    ? err(
        new GitError(
          "GIT_PREVIEW_UNAVAILABLE",
          "Comparison exceeds the diff computation limit; no partial file was displayed.",
        ),
      )
    : ok(patch);
}
