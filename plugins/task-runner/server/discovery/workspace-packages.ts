import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { isJsonObject, readJsonObject, readText } from "./files.ts";
import type { WorkspacePackage } from "./source.ts";

const MAX_GLOBSTAR_DEPTH = 8;

export function isSkippedDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !isSkippedDirectory(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function segmentPattern(segment: string): RegExp {
  const source = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`);
}

async function withDescendants(directory: string, depth: number): Promise<string[]> {
  if (depth === 0) return [directory];
  const children = await childDirectories(directory);
  const nested = await Promise.all(children.map((child) => withDescendants(join(directory, child), depth - 1)));
  return [directory, ...nested.flat()];
}

async function expandSegments(base: string, [segment, ...rest]: string[]): Promise<string[]> {
  if (segment === undefined) return [base];
  if (segment === "**") {
    const directories = await withDescendants(base, MAX_GLOBSTAR_DEPTH);
    return (await Promise.all(directories.map((directory) => expandSegments(directory, rest)))).flat();
  }
  if (!/[*?]/.test(segment)) return expandSegments(join(base, segment), rest);
  const pattern = segmentPattern(segment);
  const matches = (await childDirectories(base)).filter((child) => pattern.test(child));
  return (await Promise.all(matches.map((child) => expandSegments(join(base, child), rest)))).flat();
}

function patternSegments(pattern: string): string[] {
  return pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function excludes(pattern: string, path: string[]): boolean {
  const match = (segments: string[], at: number): boolean => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return at === path.length;
    if (segment === "**") return Array.from({ length: path.length - at + 1 }, (_, skip) => at + skip).some((next) => match(rest, next));
    const part = path[at];
    return part !== undefined && segmentPattern(segment).test(part) && match(rest, at + 1);
  };
  return match(patternSegments(pattern), 0);
}

async function declaredPatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  const pnpmWorkspace = await readText(join(root, "pnpm-workspace.yaml"));
  if (pnpmWorkspace !== null) {
    try {
      const parsed: unknown = parseYaml(pnpmWorkspace);
      if (isJsonObject(parsed) && Array.isArray(parsed.packages)) patterns.push(...parsed.packages);
    } catch {
      // A malformed file declares nothing.
    }
  }
  const workspaces = (await readJsonObject(join(root, "package.json")))?.workspaces;
  const declared = isJsonObject(workspaces) ? workspaces.packages : workspaces;
  if (Array.isArray(declared)) patterns.push(...declared);
  return patterns.filter((pattern): pattern is string => typeof pattern === "string" && !pattern.split("/").includes(".."));
}

async function declaredDirectories(root: string): Promise<string[]> {
  const patterns = await declaredPatterns(root);
  const negated = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const expanded = await Promise.all(patterns.filter((pattern) => !pattern.startsWith("!")).map((pattern) => expandSegments(root, patternSegments(pattern))));
  const directories = [...new Set(expanded.flat())];
  return directories.filter((directory) => {
    const path = relative(root, directory).split(sep);
    return directory !== root && !negated.some((pattern) => excludes(pattern, path));
  });
}

/** Only directories a workspace file declares count, so stray fixtures and vendored code stay out. */
export async function declaredPackages(root: string): Promise<WorkspacePackage[]> {
  const packages = await Promise.all(
    (await declaredDirectories(root)).map(async (directory) => {
      const manifest = await readJsonObject(join(directory, "package.json"));
      if (manifest === null) return null;
      const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : relative(root, directory);
      return { name, directory };
    }),
  );
  return packages.filter((pkg) => pkg !== null);
}
