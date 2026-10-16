import { expect, test } from "bun:test";
import { commitContext, detailsContext, fileContext, gitPrompt, refContext, reflogContext } from "./context.ts";
import { layoutGraph } from "./ui/graph.ts";
import { fullFilePatch } from "./patch.ts";
import type { GitCommit } from "./model.ts";
import { expectOk } from "../testing/results.ts";

const commit: GitCommit = { oid: "a".repeat(40), parents: ["b".repeat(40)], subject: "Subject", author: "Writer", date: "2026-10-15" };

test("커밋 목록은 해시만 첨부하고 상세 패널은 전체 상세를 첨부한다", () => {
  // Focus changes context scope without silently attaching an entire diff.
  const details = { commit, message: "Subject\n\nFull commit body\n", files: [] };

  const row = commitContext(commit);
  const panel = detailsContext(details, [{ kind: "tag", name: "v1", ref: "refs/tags/v1", oid: commit.oid }]);

  expect(row.text).toBe(commit.oid); expect(row.copy).toBe(commit.oid);
  expect(panel.text).toContain("Writer"); expect(panel.text).toContain("Full commit body"); expect(panel.text).toContain("Tags: v1");
  expect(panel.copy).toBe(commit.oid);
});

test("파일과 Diff는 동일한 경로 문맥이며 과거 revision과 연결된다", () => {
  // Historical file identity must not be confused with a current working-tree path.
  const file = { kind: "commit" as const, status: "M", path: "src/example.ts", commit };

  const context = fileContext(file);

  expect(context.copy).toBe("src/example.ts");
  expect(context.text).toBe(`File: src/example.ts\nCommit: ${commit.oid}`);
  expect(gitPrompt("review", context)).not.toContain("Subject");
});

test("브랜치 이름에는 tip 해시를 자동 첨부하지 않고 Reflog는 이벤트를 포함한다", () => {
  // Names and event context are intentional, distinct attachment scopes.
  const branch = { kind: "remote" as const, name: "origin/feature", ref: "refs/remotes/origin/feature", oid: commit.oid };

  const context = refContext(branch);
  const event = reflogContext({ oid: commit.oid, selector: "HEAD@{1}", subject: "checkout", date: "2026-10-15" });

  expect(context.text).toBe("origin/feature"); expect(context.copy).toBe("origin/feature");
  expect(event.text).toContain("HEAD@{1}"); expect(event.text).toContain("checkout"); expect(event.copy).toBe(commit.oid);
});

test("전체 파일 patch는 변경과 멀리 떨어진 줄과 동일 파일도 포함한다", () => {
  // A default hunk-only patch would omit both ends of this file.
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const after = before.replace("line 50\n", "changed 50\n");

  const patch = expectOk(fullFilePatch({ before, after, beforeLabel: "old", afterLabel: "new" }));
  const equal = expectOk(fullFilePatch({ before, after: before, beforeLabel: "old", afterLabel: "renamed" }));

  expect(patch).toContain(" line 0\n"); expect(patch).toContain(" line 99\n"); expect(patch).toContain("+changed 50");
  expect(equal).toContain(" line 99\n"); expect(equal).not.toContain("+line 99");
});

test("그래프는 merge의 두 부모와 합류 레인을 보존한다", () => {
  // A diamond history exercises lane splitting and convergence rather than a linear list.
  const make = (oid: string, parents: string[]) => ({ ...commit, oid, parents });

  const rows = layoutGraph([make("merge", ["left", "right"]), make("left", ["root"]), make("right", ["root"]), make("root", [])], 12);

  expect(rows.map((row) => row.node.filter((cell) => cell.text === "●").length)).toEqual([1, 1, 1, 1]);
  expect(rows[0]!.connector.map((cell) => cell.text).join("")).toContain("├──╮");
  expect(rows[0]!.color).toBe(rows[1]!.color);
  expect(rows[2]!.color).not.toBe(rows[1]!.color);
});
