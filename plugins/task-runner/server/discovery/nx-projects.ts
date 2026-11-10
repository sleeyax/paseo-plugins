import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isJsonObject, pathExists, readJsonObject, type JsonObject } from "./files.ts";
import type { NxProject } from "./source.ts";
import { declaredPackages, isSkippedDirectory } from "./workspace-packages.ts";

const MAX_PROJECT_DEPTH = 6;
const BUILD_OUTPUT = new Set(["dist", "build", "out", "tmp", "coverage", "target"]);

export async function isNxWorkspace(root: string): Promise<boolean> {
  return pathExists(join(root, "nx.json"));
}

/** Nx finds `project.json` anywhere in the workspace, so unlike packages these have to be walked for. */
async function projectFileDirectories(directory: string, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = entries.some((entry) => entry.isFile() && entry.name === "project.json") ? [directory] : [];
  if (depth === 0) return found;
  const children = entries.filter((entry) => entry.isDirectory() && !isSkippedDirectory(entry.name) && !BUILD_OUTPUT.has(entry.name));
  const nested = await Promise.all(children.map((child) => projectFileDirectories(join(directory, child.name), depth - 1)));
  return [...found, ...nested.flat()];
}

function targetNames(config: JsonObject | null | undefined): string[] {
  if (!config) return [];
  return Object.keys({ ...(isJsonObject(config.architect) ? config.architect : {}), ...(isJsonObject(config.targets) ? config.targets : {}) });
}

async function readProject(directory: string): Promise<NxProject | null> {
  const projectFile = await readJsonObject(join(directory, "project.json"));
  const manifest = await readJsonObject(join(directory, "package.json"));
  const nxField = isJsonObject(manifest?.nx) ? manifest.nx : null;
  if (projectFile === null && nxField === null) return null;
  const candidates = [projectFile?.name, nxField?.name, manifest?.name];
  const named = candidates.find((name): name is string => typeof name === "string" && name !== "");
  return {
    name: named ?? basename(directory),
    directory,
    targets: [...new Set([...targetNames(projectFile), ...targetNames(nxField)])],
  };
}

export async function readNxProjects(root: string): Promise<NxProject[]> {
  const directories = new Set([root, ...(await projectFileDirectories(root, MAX_PROJECT_DEPTH))]);
  for (const pkg of await declaredPackages(root)) directories.add(pkg.directory);
  const projects = await Promise.all([...directories].map(readProject));
  return projects.filter((project) => project !== null);
}
