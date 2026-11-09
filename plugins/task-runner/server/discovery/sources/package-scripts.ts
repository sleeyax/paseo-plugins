import { join } from "node:path";
import { readJsonObject, stringEntries } from "../files.ts";
import { packageManagerFor } from "../package-manager.ts";
import type { DiscoveredTask, DiscoveryContext, TaskSource, WorkspacePackage } from "../source.ts";

/** Nx shows a project's scripts as targets, so a script it already lists is not listed twice. */
function isListedByNx(script: string, pkg: WorkspacePackage, nx: DiscoveryContext["nx"]): boolean {
  const project = nx?.projects.find((candidate) => candidate.directory === pkg.directory);
  return project !== undefined && (nx?.inferred === true || project.targets.includes(script));
}

async function packageScripts(pkg: WorkspacePackage, { root, nx }: DiscoveryContext): Promise<DiscoveredTask[]> {
  const manifest = await readJsonObject(join(pkg.directory, "package.json"));
  if (manifest === null) return [];
  const manager = await packageManagerFor(pkg.directory, root);
  const scripts = stringEntries(manifest.scripts).filter(([script]) => !isListedByNx(script, pkg, nx));
  return scripts.map(([script]) => ({
    label: script,
    group: pkg.name,
    source: manager,
    command: manager,
    args: ["run", script],
    cwd: pkg.directory,
  }));
}

export const packageScriptsSource: TaskSource = {
  name: "package.json",
  async discover(context) {
    return (await Promise.all(context.packages.map((pkg) => packageScripts(pkg, context)))).flat();
  },
};
