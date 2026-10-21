import type { ExpectedError } from "../errors.ts";
import type { Result } from "../result.ts";

export type GitCommit = { oid: string; parents: string[]; subject: string; author: string; date: string };
export type GitRef = { kind: "local" | "remote" | "tag"; name: string; ref: string; oid: string };
export type GitReflog = { oid: string; selector: string; subject: string; date: string };
export type GitFile = {
  kind: "commit" | "staged" | "unstaged" | "untracked";
  status: string;
  path: string;
  originalPath?: string;
  conflicted?: boolean;
  commit?: GitCommit;
};
export type GitSnapshot = {
  commits: GitCommit[]; refs: GitRef[]; files: GitFile[]; reflog: GitReflog[];
  head: string; headOid: string | null;
};
// Branch refs point directly at this commit. Tags remain snapshot tip refs.
export type GitDetails = { commit: GitCommit; message: string; files: GitFile[]; branches: GitRef[] };
export type GitComparison = { before: string; after: string; beforeLabel: string; afterLabel: string };
export type GitSource = {
  load(reference: string | null, limit: number, signal: AbortSignal): Promise<Result<GitSnapshot, ExpectedError>>;
  details(commit: GitCommit, signal: AbortSignal): Promise<Result<GitDetails, ExpectedError>>;
  // Optional for snapshot-only adapters; repositories support commits reachable only through reflog.
  lookup?(oid: string, signal: AbortSignal): Promise<Result<GitDetails, ExpectedError>>;
  compare(file: GitFile, signal: AbortSignal): Promise<Result<GitComparison, ExpectedError>>;
};

// Persist only view identity/positions, never file contents or requests to replay.
export type GitViewState = {
  // Legacy navigation fields remain wire-compatible; the UI always restores to Commits.
  tab: "commits" | "reflog";
  right: "commit" | "refs";
  refs: "local" | "remote" | "tag";
  reference: string | null;
  selected: string | null;
  refSelected: string | null;
  reflogSelected: string | null;
  file: string | null;
  diff: boolean;
  limit: number;
  historyScroll: number;
  filesScroll: number;
  refsScroll: number;
  detailsScroll: number;
  diffScroll: number;
};
export const initialGitState = (): GitViewState => ({ tab: "commits", right: "commit", refs: "local", reference: null,
  selected: null, refSelected: null, reflogSelected: null, file: null, diff: false, limit: 300, historyScroll: 0, filesScroll: 0, refsScroll: 0, detailsScroll: 0, diffScroll: 0 });
export const fileKey = (file: GitFile): string => `${file.kind}:${file.path}`;
