import { isAbsolute, join, relative, resolve } from "node:path";
import { readText } from "../files.ts";
import type { DiscoveredTask, TaskSource, WorkspacePackage } from "../source.ts";

const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];

/** Lines that open with a directive rather than a target, even when they contain a colon. */
const DIRECTIVE = /^(?:-?include|sinclude|export|unexport|override|undefine|vpath|ifeq|ifneq|ifdef|ifndef|else|endif)\b/;
const INCLUDE = /^(?:-?include|sinclude)\s+(.+)$/;
const ASSIGNMENT = /^[^:#=\s]+\s*(?:::?:?=|\?=|\+=|!=|=)/;
const TARGET_VARIABLE = /^\s*[\w.-]+\s*(?:::?:?=|\?=|\+=|!=|=)/;
const INLINE_DESCRIPTION = /\s##\s*(.+)$/;
const LINE_DESCRIPTION = /^##\s*(.+)$/;

type Rule = { target: string; description: string | null };
type Parsed = { rules: Rule[]; phony: Set<string> };

function logicalLines(text: string): string[] {
  return text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
}

function looksLikeFile(target: string): boolean {
  return target.includes(".") || target.includes("/");
}

function isNamedTarget(target: string): boolean {
  return target !== "" && !target.startsWith(".") && !target.startsWith("-") && !target.includes("%");
}

function ruleTargets(line: string): { targets: string[]; rest: string } | null {
  const colon = line.indexOf(":");
  // A variable or function can expand to anything, and its arguments would read as target names.
  if (colon <= 0 || line.slice(0, colon).includes("$") || DIRECTIVE.test(line) || ASSIGNMENT.test(line)) return null;
  const rest = line.slice(colon + 1).replace(/^:/, "");
  if (TARGET_VARIABLE.test(rest.split("#")[0] ?? "")) return null;
  return { targets: line.slice(0, colon).trim().split(/\s+/), rest };
}

/** Read only as text, because evaluating a Makefile runs its `$(shell ...)`. */
async function parseMakefile(path: string, directory: string, root: string, seen: Set<string>, into: Parsed): Promise<boolean> {
  if (seen.has(path)) return false;
  seen.add(path);
  const text = await readText(path);
  if (text === null) return false;

  let inDefine = false;
  let pendingDescription: string | null = null;
  for (const line of logicalLines(text)) {
    if (inDefine) {
      if (/^\s*endef\b/.test(line)) inDefine = false;
      continue;
    }
    if (/^\s*define\b/.test(line)) {
      inDefine = true;
      continue;
    }
    if (line.startsWith("\t")) continue;

    const description = LINE_DESCRIPTION.exec(line)?.[1]?.trim();
    if (description !== undefined) {
      pendingDescription = description;
      continue;
    }

    const include = INCLUDE.exec(line.split("#")[0]?.trim() ?? "");
    if (include?.[1] !== undefined) {
      for (const name of include[1].trim().split(/\s+/)) {
        if (name.includes("$") || /[*?[]/.test(name)) continue;
        const included = isAbsolute(name) ? name : resolve(directory, name);
        if (isInside(root, included)) await parseMakefile(included, directory, root, seen, into);
      }
      pendingDescription = null;
      continue;
    }

    const trimmed = line.trim();
    const rule = trimmed.startsWith("#") ? null : ruleTargets(trimmed);
    if (rule !== null) {
      if (rule.targets[0] === ".PHONY") {
        for (const phony of rule.rest.split("#")[0]?.trim().split(/\s+/) ?? []) into.phony.add(phony);
      } else {
        const inline = INLINE_DESCRIPTION.exec(rule.rest)?.[1]?.trim();
        for (const target of rule.targets) into.rules.push({ target, description: inline ?? pendingDescription });
      }
    }
    pendingDescription = null;
  }
  return true;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

async function packageMakeTasks(pkg: WorkspacePackage, root: string): Promise<DiscoveredTask[]> {
  const parsed: Parsed = { rules: [], phony: new Set() };
  const seen = new Set<string>();
  for (const name of MAKEFILE_NAMES) {
    if (await parseMakefile(join(pkg.directory, name), pkg.directory, root, seen, parsed)) break;
  }
  const listed = new Map<string, Rule>();
  for (const rule of parsed.rules) {
    if (!isNamedTarget(rule.target) || (looksLikeFile(rule.target) && !parsed.phony.has(rule.target))) continue;
    const earlier = listed.get(rule.target);
    if (earlier === undefined || earlier.description === null) listed.set(rule.target, rule);
  }
  return [...listed.values()].map(({ target, description }) => ({
    label: target,
    group: pkg.name,
    source: "make",
    command: "make",
    args: [target],
    cwd: pkg.directory,
    description,
  }));
}

export const makefileSource: TaskSource = {
  name: "Makefile",
  async discover({ root, packages }) {
    return (await Promise.all(packages.map((pkg) => packageMakeTasks(pkg, root)))).flat();
  },
};
