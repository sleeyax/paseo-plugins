import { isAbsolute, join, resolve } from "node:path";
import { shellQuote } from "../../shell-quote.ts";
import { isJsonObject, readJsoncObject, type JsonObject } from "../files.ts";
import type { DiscoveredTask, TaskSource, WorkspacePackage } from "../source.ts";

const VARIABLE = /\$\{[^}]*\}/g;

function valueOf(item: unknown): string | null {
  if (typeof item === "string") return item;
  return isJsonObject(item) && typeof item.value === "string" ? item.value : null;
}

function disabledReason(parts: string[]): string | null {
  const variables = parts.flatMap((part) => part.match(VARIABLE) ?? []).filter((variable) => variable !== "${workspaceFolder}");
  const [first] = variables;
  if (first === undefined) return null;
  return first.startsWith("${input:") ? "Needs a VS Code input prompt." : `Uses ${first}, which only VS Code can fill in.`;
}

function toTask(entry: JsonObject, root: string, pkg: WorkspacePackage): DiscoveredTask | null {
  if (typeof entry.label !== "string") return null;
  const base = { label: entry.label, group: pkg.name, source: "vscode", cwd: root };

  const command = valueOf(entry.command);
  if (command === null) return { ...base, command: "", args: [], disabledReason: "Has no command to run here." };

  const args = (Array.isArray(entry.args) ? entry.args : []).map(valueOf).filter((arg) => arg !== null);
  const options = isJsonObject(entry.options) ? entry.options : null;
  const cwd = typeof options?.cwd === "string" ? options.cwd : null;

  const fill = (text: string) => text.replaceAll("${workspaceFolder}", root);
  const filledCwd = cwd === null ? root : fill(cwd);
  return {
    ...base,
    // A process task's command is a path, not shell text.
    command: entry.type === "process" ? shellQuote(fill(command)) : fill(command),
    args: args.map(fill),
    cwd: isAbsolute(filledCwd) ? filledCwd : resolve(root, filledCwd),
    disabledReason: disabledReason([command, ...args, ...(cwd === null ? [] : [cwd])]),
  };
}

export const vscodeTasksSource: TaskSource = {
  name: ".vscode/tasks.json",
  async discover({ root, packages }) {
    const [rootPackage] = packages;
    const config = await readJsoncObject(join(root, ".vscode", "tasks.json"));
    if (config === null || rootPackage === undefined || !Array.isArray(config.tasks)) return [];
    return config.tasks.filter(isJsonObject).flatMap((entry) => toTask(entry, root, rootPackage) ?? []);
  },
};
