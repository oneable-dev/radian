import type { GitCommit, GitDetails, GitFile, GitRef, GitReflog, GitSnapshot } from "./model.ts";

export type GitContext = { label: string; text: string; copy: string };

export function commitContext(commit: GitCommit): GitContext {
  return { label: `Commit ${commit.oid.slice(0, 10)}`, text: commit.oid, copy: commit.oid };
}

type CommitDescription = { commit: GitCommit; message: string; branches?: readonly GitRef[] };

export function describeCommit(
  details: CommitDescription,
  refs: readonly GitRef[],
  head?: Pick<GitSnapshot, "head" | "headOid">,
): string {
  const commit = details.commit;
  const branchNames = (kind: "local" | "remote") =>
    details.branches === undefined
      ? "…"
      : details.branches
          .filter((ref) => ref.kind === kind)
          .map((ref) => ref.name)
          .join(", ");
  const local = branchNames("local");
  const remote = branchNames("remote");
  const tags = refs
    .filter((ref) => ref.kind === "tag" && ref.oid === commit.oid)
    .map((ref) => ref.name)
    .join(", ");

  return [
    `Commit ${commit.oid}`,
    ...(head?.headOid === commit.oid
      ? [head.head ? `HEAD → ${head.head}` : "HEAD (detached)"]
      : []),
    `Branches: ${local || "—"}`,
    `Remotes: ${remote || "—"}`,
    `Tags: ${tags || "—"}`,
    `Author: ${commit.author}`,
    `Date: ${commit.date}`,
    "",
    details.message.trimEnd(),
  ].join("\n");
}

export function detailsContext(details: GitDetails, refs: readonly GitRef[]): GitContext {
  return {
    ...commitContext(details.commit),
    label: `Details ${details.commit.oid.slice(0, 10)}`,
    text: describeCommit(details, refs),
  };
}

export function fileContext(file: GitFile): GitContext {
  const revision = file.kind === "commit" ? `Commit: ${file.commit!.oid}` : `Change: ${file.kind}`;

  return { label: `File ${file.path}`, text: `File: ${file.path}\n${revision}`, copy: file.path };
}

export function refContext(ref: GitRef): GitContext {
  return {
    label: `${ref.kind === "tag" ? "Tag" : "Branch"} ${ref.name}`,
    text: ref.name,
    copy: ref.name,
  };
}

export function reflogContext(event: GitReflog): GitContext {
  return {
    label: `Reflog ${event.selector}`,
    text: `${event.selector}\n${event.oid}\n${event.date}\n${event.subject}`,
    copy: event.oid,
  };
}

export function gitPrompt(request: string, context: GitContext): string {
  // The selected content is context data, never an instruction or a shell expression.
  return `${request.trim()}\n\nGit context (quoted data):\n${JSON.stringify(context.text)}`;
}
