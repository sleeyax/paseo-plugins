import type { Task } from "../../shared/task.ts";
import { shellQuote } from "../shell-quote.ts";

const EXIT_MARKER = /^::task-exit=(\d+)::$/;

/** What an interrupted or login shell adds to the output, which is not the task's own. */
const SHELL_NOISE = /^(?:\^C|logout)$/;

const WRAPPER = [
  // Has to be a handler: an ignored signal would stay ignored in the task.
  "trap : INT",
  // The trailing `exit` keeps the task from being the shell's last command: zsh would exec that in place and never hand the terminal back.
  // Sourcing the user's profile and rc is what puts nvm, fnm or mise tools on PATH.
  '"${SHELL:-/bin/sh}" -lic "$1\nexit"',
  "code=$?",
  `printf '\\n::task-exit=%s::\\n' "$code"`,
  "trap - INT",
  // The terminal would close with its last process, taking the output with it.
  'exec "${SHELL:-/bin/sh}"',
].join("\n");

export function renderTaskCommand(task: Pick<Task, "command" | "args">): string {
  return [task.command, ...task.args.map(shellQuote)].join(" ");
}

export function wrapTask(task: Pick<Task, "command" | "args">): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", WRAPPER, "task-runner", renderTaskCommand(task)] };
}

export type TaskExit = { exitCode: number; output: string[] };

/** The first marker is the wrapper's: anything after it came from the leftover shell. */
export function readTaskExit(lines: string[]): TaskExit | null {
  const index = lines.findIndex((line) => EXIT_MARKER.test(line));
  if (index === -1) return null;
  const exitCode = Number(EXIT_MARKER.exec(lines[index] ?? "")?.[1]);
  return { exitCode, output: lines.slice(0, index) };
}

export function presentableOutput(lines: string[], limit: number): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1]?.trim() === "" || SHELL_NOISE.test(lines[end - 1] ?? ""))) end -= 1;
  let start = Math.max(0, end - limit);
  while (start < end && lines[start]?.trim() === "") start += 1;
  return lines.slice(start, end);
}
