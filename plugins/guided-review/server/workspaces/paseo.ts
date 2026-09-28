import type { PaseoApi } from "@getpaseo/client";
import type { CommandRunner } from "../command-runner.ts";
import type { WorkspacePort } from "./port.ts";
import { isSameRepository } from "./remotes.ts";

export type PaseoWorkspacesOptions = {
  /** The daemon connection, which only arrives with the first RPC and is the same one after it. */
  paseo: () => PaseoApi;
  run: CommandRunner;
};

const GIT_TIMEOUT_MS = 10_000;

export function createPaseoWorkspaces(options: PaseoWorkspacesOptions): WorkspacePort {
  return {
    async isActive(workspaceId) {
      // The listing leaves archived workspaces out, so one that is not found is one that ended.
      const workspace = await options.paseo().workspaces.ref(workspaceId).refresh();
      return workspace !== null && !workspace.archivingAt;
    },

    async findRepository(repository) {
      // A project carries no remote, so each git project's `origin` is asked. The daemon's
      // `change_request` checkout fetches from `origin` too, so that is the remote that has to match.
      const { projects } = await options.paseo().projects.list();
      for (const project of projects) {
        if (project.projectKind !== "git") continue;
        const result = await options.run({
          file: "git",
          args: ["-C", project.projectRootPath, "remote", "get-url", "origin"],
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (result.exitCode === 0 && isSameRepository(result.stdout, repository)) return project.projectRootPath;
      }
      return null;
    },

    async createChangeRequestWorkspace({ repositoryRoot, ref, title }) {
      const handle = await options.paseo().workspaces.create({
        title,
        source: {
          kind: "worktree",
          cwd: repositoryRoot,
          action: "checkout",
          checkoutSource: { kind: "change_request", forge: ref.forge, number: ref.number },
        },
      });
      const directory = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? null;
      if (directory === null) throw new Error(`Paseo created workspace ${handle.id} without a directory.`);
      return { id: handle.id, directory };
    },
  };
}
