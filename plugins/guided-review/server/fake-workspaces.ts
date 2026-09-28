import type { ChangeRequestRef } from "./forge/port.ts";
import type { FastForwardResult, ReviewWorkspace, WorkspacePort } from "./workspaces/port.ts";
import type { RemoteRepository } from "./workspaces/remotes.ts";

/** A workspace the reviewer has open, as its checkout describes it. */
export type FakeCheckout = {
  directory: string;
  branch: string | null;
  repository: RemoteRepository | null;
  /** What fast-forwarding it comes to. */
  outcome: FastForwardResult;
};

/** Paseo's workspaces as a test arranges them: which repositories have projects, and what was created. */
export type FakeWorkspaces = WorkspacePort & {
  /** The reviewer's own workspaces, by ID; see `openCheckout`. */
  checkouts: Map<string, FakeCheckout>;
  /** Every fast-forward asked for. */
  fastForwards: { workspaceId: string; branch: string; ref: ChangeRequestRef; headSha: string }[];
  /** Opens one of the reviewer's own workspaces. */
  openCheckout(workspaceId: string, checkout: FakeCheckout): void;
  /** Project roots by `host/project`. */
  repositories: Map<string, string>;
  created: { id: string; repositoryRoot: string; ref: ChangeRequestRef; title: string }[];
  /** Archives a workspace, as the reviewer would from the sidebar. */
  archive(workspaceId: string): void;
  /** When set, the next creation fails with it. */
  failCreate: Error | null;
};

export function fakeWorkspaces(): FakeWorkspaces {
  const active = new Set<string>();
  const workspaces: FakeWorkspaces = {
    repositories: new Map(),
    checkouts: new Map(),
    fastForwards: [],
    created: [],
    failCreate: null,
    archive(workspaceId) {
      active.delete(workspaceId);
    },
    openCheckout(workspaceId, checkout) {
      workspaces.checkouts.set(workspaceId, checkout);
      active.add(workspaceId);
    },
    async inspect(workspaceId) {
      const checkout = workspaces.checkouts.get(workspaceId);
      if (checkout === undefined || !active.has(workspaceId)) return null;
      return {
        workspace: { id: workspaceId, directory: checkout.directory },
        branch: checkout.branch,
        repository: checkout.repository,
      };
    },
    async fastForward({ workspace, branch, ref, headSha }) {
      workspaces.fastForwards.push({ workspaceId: workspace.id, branch, ref, headSha });
      const checkout = workspaces.checkouts.get(workspace.id);
      if (checkout === undefined) return { status: "failed", message: `No checkout at ${workspace.directory}.` };
      return checkout.outcome;
    },
    async isActive(workspaceId) {
      return active.has(workspaceId);
    },
    async findRepository(repository: RemoteRepository) {
      return workspaces.repositories.get(`${repository.host}/${repository.project}`) ?? null;
    },
    async createChangeRequestWorkspace({ repositoryRoot, ref, title }): Promise<ReviewWorkspace> {
      if (workspaces.failCreate) {
        const error = workspaces.failCreate;
        workspaces.failCreate = null;
        throw error;
      }
      const id = `wks_${String(workspaces.created.length + 1).padStart(16, "0")}`;
      workspaces.created.push({ id, repositoryRoot, ref, title });
      const directory = `${repositoryRoot}-worktrees/pr-${ref.number}`;
      // Paseo checks a PR out on a local branch of its own, which fast-forwards like any other.
      workspaces.openCheckout(id, { directory, branch: `pr-${ref.number}`, repository: { host: ref.host, project: ref.project }, outcome: { status: "current" } });
      return { id, directory };
    },
  };
  return workspaces;
}
