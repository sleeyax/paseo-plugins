import { basename, join } from "node:path";
import { TASK_TERMINAL_PREFIX, type NxStatus, type Task } from "../../shared/task.ts";
import { readJsonObject } from "./files.ts";
import type { InferredTargets } from "./inferred-targets.ts";
import { isNxWorkspace, readNxProjects } from "./nx-projects.ts";
import type { DiscoveredTask, NxWorkspace, TaskSource, WorkspacePackage } from "./source.ts";
import { makefileSource } from "./sources/makefile.ts";
import { nxSource } from "./sources/nx.ts";
import { packageScriptsSource } from "./sources/package-scripts.ts";
import { vscodeTasksSource } from "./sources/vscode-tasks.ts";
import { declaredPackages } from "./workspace-packages.ts";

export const TASK_SOURCES: TaskSource[] = [packageScriptsSource, makefileSource, nxSource, vscodeTasksSource];

export type DiscoverOptions = {
  root: string;
  /** Given only when the user asked for inferred targets: it executes the repo's own nx. */
  inferred?: InferredTargets | undefined;
  log?: (message: string) => void;
};

export type Discovery = {
  tasks: Task[];
  nx: NxStatus | null;
};

async function rootPackage(root: string): Promise<WorkspacePackage> {
  const manifest = await readJsonObject(join(root, "package.json"));
  const name = typeof manifest?.name === "string" && manifest.name !== "" ? manifest.name : basename(root);
  return { name, directory: root };
}

/** A later task with a label its group already has keeps its own terminal under a suffixed label. */
function withUniqueLabels(tasks: DiscoveredTask[]): DiscoveredTask[] {
  const taken = new Set<string>();
  return tasks.map((task) => {
    const key = (candidate: string) => `${task.group}\0${candidate}`;
    let label = task.label;
    for (let repeat = 1; taken.has(key(label)); repeat += 1) {
      label = `${task.label} (${task.source}${repeat === 1 ? "" : ` ${repeat}`})`;
    }
    taken.add(key(label));
    return { ...task, label };
  });
}

function toTask(task: DiscoveredTask, rootGroup: string): Task {
  return {
    ...task,
    id: `${TASK_TERMINAL_PREFIX}${task.group === rootGroup ? "" : `${task.group}: `}${task.label}`,
    description: task.description ?? null,
    disabledReason: task.disabledReason ?? null,
  };
}

type NxDiscovery = { workspace: NxWorkspace | null; status: NxStatus | null };

async function discoverNx(root: string, inferred: InferredTargets | undefined): Promise<NxDiscovery> {
  if (!(await isNxWorkspace(root))) return { workspace: null, status: null };
  const fromFiles = async (): Promise<NxWorkspace> => ({ projects: await readNxProjects(root), inferred: false });
  if (inferred === undefined) return { workspace: await fromFiles(), status: { inferred: "off", failure: null } };
  const read = await inferred.read(root);
  switch (read.state) {
    case "ready":
      return { workspace: { projects: read.projects, inferred: true }, status: { inferred: "on", failure: null } };
    case "loading":
      return { workspace: await fromFiles(), status: { inferred: "loading", failure: null } };
    case "failed":
      return { workspace: await fromFiles(), status: { inferred: "failed", failure: read.reason } };
  }
}

/** An Nx project takes over the group of the package in its directory, since `nx run` goes by its name. */
function withNxProjects(packages: WorkspacePackage[], nx: NxWorkspace | null): WorkspacePackage[] {
  const merged = new Map(packages.map((pkg) => [pkg.directory, pkg]));
  for (const project of nx?.projects ?? []) merged.set(project.directory, { name: project.name, directory: project.directory });
  return [...merged.values()];
}

export async function discoverTasks({ root, inferred, log }: DiscoverOptions): Promise<Discovery> {
  const nx = await discoverNx(root, inferred);
  const [rootPkg, ...others] = withNxProjects([await rootPackage(root), ...(await declaredPackages(root))], nx.workspace);
  if (rootPkg === undefined) throw new Error("Discovery always has a root package.");
  const packages = [rootPkg, ...others.sort((a, b) => a.name.localeCompare(b.name))];
  const context = { root, packages, nx: nx.workspace };
  const results = await Promise.all(
    TASK_SOURCES.map((source) =>
      source.discover(context).catch((error: unknown) => {
        log?.(`${source.name} discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }),
    ),
  );
  const groupOrder = new Map(packages.map((pkg, index) => [pkg.name, index]));
  const position = (task: DiscoveredTask) => groupOrder.get(task.group) ?? packages.length;
  const tasks = withUniqueLabels(results.flat().sort((a, b) => position(a) - position(b)));
  return { tasks: tasks.map((task) => toTask(task, rootPkg.name)), nx: nx.status };
}
