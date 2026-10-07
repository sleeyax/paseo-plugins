import { spawn } from "node:child_process";

export type CommandRequest = {
  file: string;
  args: readonly string[];
  /** Where it runs; the daemon's own directory when absent. */
  cwd?: string;
  /** Written to stdin, which is then closed. Without it stdin is closed from the start. */
  input?: string;
  /** Laid over the daemon's environment, so a caller names only what it changes. */
  env?: Record<string, string>;
  /** Taken out of the daemon's environment, for a variable whose mere presence changes what a tool does. */
  unsetEnv?: readonly string[];
  timeoutMs: number;
  /** `base64` for a file the command prints, whose bytes a UTF-8 decode would corrupt. */
  stdoutEncoding?: "utf8" | "base64";
  /** A smaller cap than `MAX_STDOUT_BYTES`, for a call whose answer has a size limit of its own. */
  maxStdoutBytes?: number;
};

export type CommandResult = {
  exitCode: number | null;
  /** All of it: forge JSON is only useful whole. */
  stdout: string;
  /** The tail, which is where a failing CLI says why. */
  stderr: string;
  /** Set when the command did not run to an exit code: it could not start, timed out, or said too much. */
  spawnError: string | null;
  /** Set when it said too much: printed more than its cap. */
  outputExceeded?: true;
};

/**
 * The seam every `gh`, `glab` and `git` call goes through. It never rejects: a command that fails is
 * data for the caller to turn into a sentence, and tests replace it with a recording fake.
 */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

/** A message is at the end of stderr, and a whole log is no use in an RPC payload. */
const MAX_STDERR = 16_000;

/**
 * Far beyond any PR's JSON, and only there so a runaway command cannot take the daemon's memory with
 * it. Crossing it is a failure rather than a truncation, because a cut-off JSON document is worse
 * than none.
 */
export const MAX_STDOUT_BYTES = 256 * 1024 * 1024;

export const runCommand: CommandRunner = (request) =>
  new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: environment(request),
        stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", spawnError: messageOf(error) });
      return;
    }

    const maxStdoutBytes = request.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    // Decoded once at the end, so a multi-byte character split across two chunks survives.
    const collected = () => Buffer.concat(stdout).toString(request.stdoutEncoding ?? "utf8");
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (spawnError: string, outputExceeded = false) => {
      child.kill("SIGKILL");
      settle({ exitCode: null, stdout: collected(), stderr, spawnError, ...(outputExceeded ? { outputExceeded: true } : {}) });
    };
    const timer = setTimeout(() => fail(`Timed out after ${request.timeoutMs}ms`), request.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(`Output exceeded ${maxStdoutBytes} bytes`, true);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error: Error) => settle({ exitCode: null, stdout: collected(), stderr, spawnError: error.message }));
    child.on("close", (code) => settle({ exitCode: code, stdout: collected(), stderr, spawnError: null }));

    if (request.input !== undefined) {
      // A command that exits without reading its input closes the pipe under the write; its exit
      // code is the answer, not the EPIPE.
      child.stdin!.on("error", () => {});
      child.stdin!.end(request.input);
    }
  });

function environment(request: CommandRequest): NodeJS.ProcessEnv {
  const env = { ...process.env, ...request.env };
  for (const name of request.unsetEnv ?? []) delete env[name];
  return env;
}

function keepTail(text: string): string {
  return text.length <= MAX_STDERR ? text : text.slice(text.length - MAX_STDERR);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
