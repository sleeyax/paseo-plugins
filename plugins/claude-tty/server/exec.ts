import { spawn } from "node:child_process";

/** Enough of a failing build to diagnose it, without carrying a whole log through an RPC payload. */
const MAX_CAPTURED = 16_000;

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command never ran at all, which a shell would have reported instead of an exit code. */
  spawnError: string | null;
};

export function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ exitCode: null, stdout, stderr, spawnError: `Timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error: Error) => settle({ exitCode: null, stdout, stderr, spawnError: error.message }));
    child.on("close", (code) => settle({ exitCode: code, stdout, stderr, spawnError: null }));
  });
}

function keepTail(text: string): string {
  return text.length <= MAX_CAPTURED ? text : text.slice(text.length - MAX_CAPTURED);
}
