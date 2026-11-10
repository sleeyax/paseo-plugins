import { execCommand, packageManagerFor } from "../package-manager.ts";
import type { DiscoveredTask, NxProject, TaskSource } from "../source.ts";

async function projectTasks(project: NxProject, root: string): Promise<DiscoveredTask[]> {
  const exec = execCommand(await packageManagerFor(project.directory, root));
  return project.targets.map((target) => ({
    label: target,
    group: project.name,
    source: "nx",
    command: exec.command,
    args: [...exec.args, "nx", "run", `${project.name}:${target}`],
    cwd: project.directory,
  }));
}

export const nxSource: TaskSource = {
  name: "nx",
  async discover({ root, nx }) {
    return (await Promise.all((nx?.projects ?? []).map((project) => projectTasks(project, root)))).flat();
  },
};
