import { dirname, join, relative } from "node:path";
import { pathExists, readJsonObject } from "./files.ts";

const MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof MANAGERS)[number];

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

async function declaredManager(directory: string): Promise<PackageManager | null> {
  const field = (await readJsonObject(join(directory, "package.json")))?.packageManager;
  if (typeof field !== "string") return null;
  return MANAGERS.find((manager) => field === manager || field.startsWith(`${manager}@`)) ?? null;
}

async function lockfileManager(directory: string, root: string): Promise<PackageManager | null> {
  for (let current = directory; ; current = dirname(current)) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (await pathExists(join(current, lockfile))) return manager;
    }
    if (relative(root, current) === "") return null;
  }
}

export async function packageManagerFor(directory: string, root: string): Promise<PackageManager> {
  return (await declaredManager(directory)) ?? (await declaredManager(root)) ?? (await lockfileManager(directory, root)) ?? "npm";
}

export function execCommand(manager: PackageManager): { command: string; args: string[] } {
  switch (manager) {
    case "npm":
      return { command: "npx", args: [] };
    case "pnpm":
      return { command: "pnpm", args: ["exec"] };
    case "yarn":
      return { command: "yarn", args: [] };
    case "bun":
      return { command: "bunx", args: [] };
  }
}
