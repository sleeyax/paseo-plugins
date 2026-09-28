/**
 * What the review service asks of a forge. Each forge has one adapter implementing it over its CLI
 * (`gh`, `glab`) through a command runner, so a test replays recorded output through a fake runner
 * and the service is tested against a fake of this port.
 *
 * Grows with the tickets that need it: resolving a branch to its change request, the current user's
 * drafts, submitting and discarding a review.
 */
export interface Forge {
  readonly kind: ForgeKind;
  /** How the service describes a URL this forge takes, in a sentence that rejects one it does not. */
  readonly urlHint: string;
  /** The change request a pasted URL names, or null when the URL is not one of this forge's. */
  matchUrl(url: string): Promise<ChangeRequestRef | null>;
  fetchChangeRequest(ref: ChangeRequestRef): Promise<ChangeRequest>;
  /** Who the CLI is logged in as on the change request's host. */
  currentUser(ref: ChangeRequestRef): Promise<ForgeUser>;
  /** Clones the change request's repository into `directory`, which must not exist yet. */
  cloneRepository(ref: ChangeRequestRef, directory: string): Promise<void>;
}

export type ForgeKind = "github" | "gitlab";

/** A change request as its URL names it: enough to address it, before anything is read. */
export type ChangeRequestRef = {
  forge: ForgeKind;
  /** The web host, lower-cased: `github.com`. */
  host: string;
  /** The repository path on that host: `owner/repo`, or `group/sub/project` on GitLab. */
  project: string;
  number: number;
  /** The canonical web URL, whatever suffix the pasted one had. */
  url: string;
};

export type ChangeRequestState = "open" | "closed" | "merged";

export type ForgeUser = {
  login: string;
  name: string | null;
};

export type ChangedFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

export type ChangedFile = {
  path: string;
  /** Where a renamed or copied file came from. */
  previousPath: string | null;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  /**
   * The file's unified diff from its first `@@`, without the `diff --git` header. Null when the forge
   * gave none, which it does for binary files and for diffs too large to show.
   */
  patch: string | null;
};

export type ChangeRequestCommit = {
  sha: string;
  headline: string;
  body: string;
  author: string;
  authoredAt: string;
};

export type LinkedIssue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
};

/** Everything the guide is built from, read at one head SHA. */
export type ChangeRequest = {
  ref: ChangeRequestRef;
  title: string;
  description: string;
  author: ForgeUser;
  state: ChangeRequestState;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  commits: ChangeRequestCommit[];
  linkedIssues: LinkedIssue[];
  files: ChangedFile[];
};

/** A forge call that failed, with a message fit to show the reviewer as it is. */
export class ForgeError extends Error {
  override name = "ForgeError";
}
