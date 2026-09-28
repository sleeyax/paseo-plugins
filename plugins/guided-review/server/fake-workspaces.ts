import type { ChangeRequestRef } from "./forge/port.ts";
import type { ReviewWorkspace, WorkspacePort } from "./workspaces/port.ts";
import type { RemoteRepository } from "./workspaces/remotes.ts";

/** Paseo's workspaces as a test arranges them: which repositories have projects, and what was created. */
export type FakeWorkspaces = WorkspacePort & {
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
    created: [],
    failCreate: null,
    archive(workspaceId) {
      active.delete(workspaceId);
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
      active.add(id);
      return { id, directory: `${repositoryRoot}-worktrees/pr-${ref.number}` };
    },
  };
  return workspaces;
}
