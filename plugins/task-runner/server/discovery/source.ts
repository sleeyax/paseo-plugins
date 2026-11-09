import type { Task } from "../../shared/task.ts";

export type WorkspacePackage = {
  /** The group its tasks are listed under. */
  name: string;
  directory: string;
};

export type NxProject = {
  name: string;
  directory: string;
  targets: string[];
};

export type NxWorkspace = {
  projects: NxProject[];
  /** Whether the targets came from the Nx CLI, which knows every target, rather than from files. */
  inferred: boolean;
};

export type DiscoveryContext = {
  root: string;
  /** The workspace root first, then each declared package and Nx project. */
  packages: WorkspacePackage[];
  nx: NxWorkspace | null;
};

export type DiscoveredTask = Pick<Task, "label" | "group" | "source" | "command" | "args" | "cwd"> &
  Partial<Pick<Task, "description" | "disabledReason">>;

/** Adding a language means adding one of these to `TASK_SOURCES`. */
export type TaskSource = {
  name: string;
  discover(context: DiscoveryContext): Promise<DiscoveredTask[]>;
};
