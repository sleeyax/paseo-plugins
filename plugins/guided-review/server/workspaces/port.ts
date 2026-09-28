import type { ChangeRequestRef } from "../forge/port.ts";
import type { RemoteRepository } from "./remotes.ts";

/** A Paseo workspace a guide lives in. */
export type ReviewWorkspace = {
  id: string;
  directory: string;
};

/**
 * What the review service asks of Paseo's workspaces. `server/workspaces/paseo.ts` implements it over
 * the SDK; tests use a fake.
 *
 * Grows with the tickets that need it: finding a workspace on a change request's source branch, and
 * fast-forwarding it through the local checkout module.
 */
export interface WorkspacePort {
  /** False once the workspace is archived or gone, which is what ends a guide. */
  isActive(workspaceId: string): Promise<boolean>;
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
