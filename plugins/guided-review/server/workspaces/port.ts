import type { ChangeRequestRef } from "../forge/port.ts";
import type { FastForwardResult } from "./checkout.ts";
import type { RemoteRepository } from "./remotes.ts";

export type { FastForwardResult } from "./checkout.ts";

/** A Paseo workspace a guide lives in. */
export type ReviewWorkspace = {
  id: string;
  directory: string;
  /**
   * Set when the workspace is the reviewer's own, on the change request's source branch, which the
   * plugin fast-forwards to the head instead of making a PR workspace. Absent on a PR workspace.
   */
  branch?: string;
};

/** A workspace as its checkout describes it, which is how its branch's change request is found. */
export type WorkspaceCheckout = {
  workspace: ReviewWorkspace;
  /** Null when HEAD is detached. */
  branch: string | null;
  /** Where `origin` points, or null when it has none a forge could be asked about. */
  repository: RemoteRepository | null;
};

/**
 * What the review service asks of Paseo's workspaces. `server/workspaces/paseo.ts` implements it over
 * the SDK; tests use a fake.
 *
 * The reviewer's own checkouts are read and fast-forwarded through the local checkout module
 * (`server/workspaces/checkout.ts`), on the daemon's host: Paseo's own record of a workspace's
 * branch is a cache that is not always there.
 */
export interface WorkspacePort {
  /** False once the workspace is archived or gone, which is what ends a guide. */
  isActive(workspaceId: string): Promise<boolean>;
  /** The workspace's branch and repository, read from its checkout; null once it is archived or gone. */
  inspect(workspaceId: string): Promise<WorkspaceCheckout | null>;
  /**
   * Brings the workspace's `branch` to the change request's `headSha`, fetched from the change
   * request's own ref on `origin`, when that is a clean fast-forward; otherwise leaves it untouched
   * and says why.
   */
  fastForward(input: { workspace: ReviewWorkspace; branch: string; ref: ChangeRequestRef; headSha: string }): Promise<FastForwardResult>;
  /** A file's text at a commit of the workspace's repository; null when git cannot show it there. */
  fileAt(input: { workspace: ReviewWorkspace; sha: string; path: string }): Promise<string | null>;
  /** The root of a Paseo project whose `origin` is this repository, if there is one. */
  findRepository(repository: RemoteRepository): Promise<string | null>;
  /**
   * A new workspace on a worktree of `repositoryRoot`, checked out at the change request's head.
   * Takes as long as a fetch and the project's setup scripts do, so it is never awaited in an RPC.
   */
  createChangeRequestWorkspace(input: {
    repositoryRoot: string;
    ref: ChangeRequestRef;
    title: string;
  }): Promise<ReviewWorkspace>;
}
