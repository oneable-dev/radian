import { expect, test } from "bun:test";
import { commitContext, describeCommit, detailsContext, fileContext, gitPrompt, refContext, reflogContext } from "./context.ts";
import { layoutGraph } from "./ui/graph.ts";
import { fullFilePatch } from "./patch.ts";
import type { GitCommit } from "./model.ts";
import { expectOk } from "../testing/results.ts";

const commit: GitCommit = { oid: "a".repeat(40), parents: ["b".repeat(40)], subject: "Subject", author: "Writer", date: "2026-10-15" };

test("Commit context includes only hashes while details preserve full messages and tags", () => {
  // Focus changes context scope without silently attaching an entire diff.
  const details = { commit, message: "Subject\n\nFull commit body\n", files: [], branches: [] };

  const row = commitContext(commit);
  const panel = detailsContext(details, [{ kind: "tag", name: "v1", ref: "refs/tags/v1", oid: commit.oid }]);

  expect(row.text).toBe(commit.oid); expect(row.copy).toBe(commit.oid);
  expect(panel.text).toContain("Writer"); expect(panel.text).toContain("Full commit body"); expect(panel.text).toContain("Tags: v1");
  expect(panel.copy).toBe(commit.oid);
});

test("Commit details include matching HEAD, local/remote branches, and tags", () => {
  // Prepare multiple refs on one commit alongside refs targeting another commit.
  const refs = [
    { kind: "local" as const, name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "local" as const, name: "feature/topic", ref: "refs/heads/feature/topic", oid: commit.oid },
    { kind: "remote" as const, name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag" as const, name: "v1", ref: "refs/tags/v1", oid: commit.oid },
    { kind: "tag" as const, name: "unrelated", ref: "refs/tags/unrelated", oid: "b".repeat(40) },
  ];

  // Details retain full messages and exact ref targets instead of screen summaries.
  const text = describeCommit({ commit, message: "Subject\n\nComplete message\n", branches: refs.filter(ref => ref.kind !== "tag") }, refs, { head: "main", headOid: commit.oid });

  expect(text).toContain(`Commit ${commit.oid}`); expect(text).toContain("Author: Writer"); expect(text).toContain("Date: 2026-10-15");
  expect(text).toContain("HEAD → main"); expect(text).toContain("Branches: main, feature/topic");
  expect(text).toContain("Remotes: origin/main"); expect(text).toContain("Tags: v1"); expect(text).toContain("Complete message");
  expect(text).not.toContain("unrelated");
});

test("Detached HEAD never appears as a branch and unrelated details omit HEAD", () => {
  // Distinguish branchless HEAD targets from other commit details.
  const details = { commit, message: "Subject", files: [], branches: [] };

  const detached = describeCommit(details, [], { head: "", headOid: commit.oid });
  const other = describeCommit(details, [], { head: "main", headOid: "b".repeat(40) });

  expect(detached).toContain("HEAD (detached)"); expect(detached).toContain("Branches: —");
  expect(other).not.toContain("HEAD"); expect(other).toContain(`Commit ${commit.oid}`);
});

test("Refless commits retain branch, remote, and tag fields with explicit empty values", () => {
  // No directly pointing branches differs from an unavailable lookup.
  const details = { commit, message: "Subject", files: [], branches: [] };

  const text = describeCommit(details, []);

  expect(text).toContain("Branches: —\nRemotes: —\nTags: —");
  expect(text.indexOf("Branches:")).toBeLessThan(text.indexOf("Author:"));
  expect(text.indexOf("Tags:")).toBeLessThan(text.indexOf("Author:"));
  expect(text).not.toContain("HEAD");
});

test("Unqueried branch refs never appear as empty results", () => {
  // Old snapshots or pending lookups must not imply empty refs before fresh responses.
  const refs = [{ kind: "local" as const, name: "main", ref: "refs/heads/main", oid: commit.oid }];

  const text = describeCommit({ commit, message: "Loading commit details…" }, refs);

  expect(text).toContain("Branches: …\nRemotes: …"); expect(text).not.toContain("Branches: main");
  expect(text).not.toContain("Branches: —"); expect(text).toContain("Tags: —");
});

test("Files and diffs share path context linked to historical revisions", () => {
  // Historical file identity must not be confused with a current working-tree path.
  const file = { kind: "commit" as const, status: "M", path: "src/example.ts", commit };

  const context = fileContext(file);

  expect(context.copy).toBe("src/example.ts");
  expect(context.text).toBe(`File: src/example.ts\nCommit: ${commit.oid}`);
  expect(gitPrompt("review", context)).not.toContain("Subject");
});

test("Branch names never automatically append tip hashes and reflogs include events", () => {
  // Names and event context are intentional, distinct attachment scopes.
  const branch = { kind: "remote" as const, name: "origin/feature", ref: "refs/remotes/origin/feature", oid: commit.oid };

  const context = refContext(branch);
  const event = reflogContext({ oid: commit.oid, selector: "HEAD@{1}", subject: "checkout", date: "2026-10-15" });

  expect(context.text).toBe("origin/feature"); expect(context.copy).toBe("origin/feature");
  expect(event.text).toContain("HEAD@{1}"); expect(event.text).toContain("checkout"); expect(event.copy).toBe(commit.oid);
});

test("Full-file patches include distant changes and unchanged files", () => {
  // A default hunk-only patch would omit both ends of this file.
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const after = before.replace("line 50\n", "changed 50\n");

  const patch = expectOk(fullFilePatch({ before, after, beforeLabel: "old", afterLabel: "new" }));
  const equal = expectOk(fullFilePatch({ before, after: before, beforeLabel: "old", afterLabel: "renamed" }));

  expect(patch).toContain(" line 0\n"); expect(patch).toContain(" line 99\n"); expect(patch).toContain("+changed 50");
  expect(equal).toContain(" line 99\n"); expect(equal).not.toContain("+line 99");
});

test("Graphs preserve merge parents and joining lanes", () => {
  // A diamond history exercises lane splitting and convergence rather than a linear list.
  const make = (oid: string, parents: string[]) => ({ ...commit, oid, parents });

  const rows = layoutGraph([make("merge", ["left", "right"]), make("left", ["root"]), make("right", ["root"]), make("root", [])], 12);

  expect(rows.map((row) => row.node.filter((cell) => cell.text === "●").length)).toEqual([1, 1, 1, 1]);
  expect(rows[0]!.connector.map((cell) => cell.text).join("")).toContain("├──╮");
  expect(rows[0]!.color).toBe(rows[1]!.color);
  expect(rows[2]!.color).not.toBe(rows[1]!.color);
});
