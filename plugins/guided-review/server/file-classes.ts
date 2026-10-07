import type { SupportingEntry } from "../shared/guide.ts";

/**
 * Lockfiles and generated files, told apart by path alone before the guide is generated: the guide
 * agent never sees them, which keeps a large change within its context, and they go straight into
 * Supporting. Anything the paths do not give away is left to the agent.
 */

export type SetAsideCategory = "lockfile" | "generated";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "packages.lock.json",
  "gradle.lockfile",
  "Package.resolved",
]);

/** `yarn.lock`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `flake.lock` and the rest. */
const LOCK_SUFFIX = ".lock";

const GENERATED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".js.map",
  ".css.map",
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  "_pb2.py",
  "_pb2_grpc.py",
  ".g.dart",
  ".freezed.dart",
  ".snap",
];

const GENERATED_INFIXES = [".generated.", "_generated."];

const GENERATED_DIRECTORIES = new Set(["__generated__", "__snapshots__"]);

/** What a changed file is by its path, or null when its path says nothing. */
export function classifyPath(filePath: string): SetAsideCategory | null {
  const segments = filePath.split("/");
  const name = segments.at(-1)!;
  if (LOCKFILES.has(name) || name.endsWith(LOCK_SUFFIX)) return "lockfile";
  if (GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "generated";
  if (GENERATED_INFIXES.some((infix) => name.includes(infix))) return "generated";
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))) return "generated";
  return null;
}

/**
 * Sets aside, as well, the files of `split.sent` the own work does not change, by either path, for
 * a guide of the own work: only other change requests' commits change them.
 */
export function keepOwnWork<T extends { path: string; previousPath: string | null }>(
  split: { sent: T[]; setAside: SupportingEntry[] },
  ownPaths: readonly string[],
): { sent: T[]; setAside: SupportingEntry[] } {
  const own = new Set(ownPaths);
  const isOwn = (file: T) => own.has(file.path) || (file.previousPath !== null && own.has(file.previousPath));
  return {
    sent: split.sent.filter(isOwn),
    setAside: [...split.setAside, ...split.sent.filter((file) => !isOwn(file)).map((file) => ({ path: file.path, category: "foreign" as const }))],
  };
}

/** Splits the changed files into those the agent reads and those set aside for Supporting. */
export function setAside<T extends { path: string }>(files: readonly T[]): { sent: T[]; setAside: SupportingEntry[] } {
  const sent: T[] = [];
  const aside: SupportingEntry[] = [];
  for (const file of files) {
    const category = classifyPath(file.path);
    if (category === null) sent.push(file);
    else aside.push({ path: file.path, category });
  }
  return { sent, setAside: aside };
}
