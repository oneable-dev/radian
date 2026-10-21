import { expect, test } from "bun:test";
import { commitContext, describeCommit, detailsContext, fileContext, gitPrompt, refContext, reflogContext } from "./context.ts";
import { layoutGraph } from "./ui/graph.ts";
import { fullFilePatch } from "./patch.ts";
import type { GitCommit } from "./model.ts";
import { expectOk } from "../testing/results.ts";

const commit: GitCommit = { oid: "a".repeat(40), parents: ["b".repeat(40)], subject: "Subject", author: "Writer", date: "2026-10-15" };

test("커밋 문맥은 해시만 포함하고 상세 문맥은 전체 메시지와 태그를 보존한다", () => {
  // Focus changes context scope without silently attaching an entire diff.
  const details = { commit, message: "Subject\n\nFull commit body\n", files: [], branches: [] };

  const row = commitContext(commit);
  const panel = detailsContext(details, [{ kind: "tag", name: "v1", ref: "refs/tags/v1", oid: commit.oid }]);

  expect(row.text).toBe(commit.oid); expect(row.copy).toBe(commit.oid);
  expect(panel.text).toContain("Writer"); expect(panel.text).toContain("Full commit body"); expect(panel.text).toContain("Tags: v1");
  expect(panel.copy).toBe(commit.oid);
});

test("커밋 상세는 해당 커밋의 HEAD·로컬/원격 브랜치·태그를 모두 포함한다", () => {
  // 같은 커밋에 여러 ref가 있고 다른 커밋의 ref도 조회된 상태를 준비한다.
  const refs = [
    { kind: "local" as const, name: "main", ref: "refs/heads/main", oid: commit.oid },
    { kind: "local" as const, name: "feature/topic", ref: "refs/heads/feature/topic", oid: commit.oid },
    { kind: "remote" as const, name: "origin/main", ref: "refs/remotes/origin/main", oid: commit.oid },
    { kind: "tag" as const, name: "v1", ref: "refs/tags/v1", oid: commit.oid },
    { kind: "tag" as const, name: "unrelated", ref: "refs/tags/unrelated", oid: "b".repeat(40) },
  ];

  // 화면 요약 대신 전체 메시지와 정확한 ref 대상이 상세 문맥에 남아야 한다.
  const text = describeCommit({ commit, message: "Subject\n\nComplete message\n", branches: refs.filter(ref => ref.kind !== "tag") }, refs, { head: "main", headOid: commit.oid });

  expect(text).toContain(`Commit ${commit.oid}`); expect(text).toContain("Author: Writer"); expect(text).toContain("Date: 2026-10-15");
  expect(text).toContain("HEAD → main"); expect(text).toContain("Branches: main, feature/topic");
  expect(text).toContain("Remotes: origin/main"); expect(text).toContain("Tags: v1"); expect(text).toContain("Complete message");
  expect(text).not.toContain("unrelated");
});

test("detached HEAD는 브랜치처럼 표시하지 않고 다른 커밋 상세에는 HEAD를 붙이지 않는다", () => {
  // 브랜치 없이 커밋을 직접 가리키는 HEAD와 다른 커밋의 상세를 구분한다.
  const details = { commit, message: "Subject", files: [], branches: [] };

  const detached = describeCommit(details, [], { head: "", headOid: commit.oid });
  const other = describeCommit(details, [], { head: "main", headOid: "b".repeat(40) });

  expect(detached).toContain("HEAD (detached)"); expect(detached).toContain("Branches: —");
  expect(other).not.toContain("HEAD"); expect(other).toContain(`Commit ${commit.oid}`);
});

test("커밋에 ref가 없어도 브랜치·원격·태그 항목을 숨기지 않고 빈 값을 명시한다", () => {
  // 포함 브랜치가 없는 커밋도 값을 조회하지 못한 것과 구분할 수 있어야 한다.
  const details = { commit, message: "Subject", files: [], branches: [] };

  const text = describeCommit(details, []);

  expect(text).toContain("Branches: —\nRemotes: —\nTags: —");
  expect(text.indexOf("Branches:")).toBeLessThan(text.indexOf("Author:"));
  expect(text.indexOf("Tags:")).toBeLessThan(text.indexOf("Author:"));
  expect(text).not.toContain("HEAD");
});

test("포함 브랜치를 아직 조회하지 않은 상세는 빈 결과로 표시하지 않는다", () => {
  // tip ref만으로 --contains 결과를 추정하거나 미조회 상태를 없음으로 가장하면 안 된다.
  const refs = [{ kind: "local" as const, name: "main", ref: "refs/heads/main", oid: commit.oid }];

  const text = describeCommit({ commit, message: "Loading commit details…" }, refs);

  expect(text).toContain("Branches: …\nRemotes: …"); expect(text).not.toContain("Branches: main");
  expect(text).not.toContain("Branches: —"); expect(text).toContain("Tags: —");
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
