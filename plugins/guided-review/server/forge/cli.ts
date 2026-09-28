import type { z } from "zod";
import type { CommandRunner } from "../command-runner.ts";
import { ForgeError } from "./port.ts";

export type CliOptions = {
  run: CommandRunner;
  /** The executable, read from the settings at every call because the setting can change. */
  binary: () => Promise<string>;
  /** How the tool is named in a message: `gh`. */
  name: string;
  /** Laid over the daemon's environment for every call. */
  env: Record<string, string>;
};

export type CallOptions = {
  /** Written to stdin; the tool reads it with `--input -`. */
  input?: string;
  timeoutMs?: number;
};

/** Long enough for a paginated file list on a large PR, short enough that a hung call ends. */
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/** One forge CLI, whose failures come back as a `ForgeError` in a sentence. */
export type Cli = {
  text(args: readonly string[], options?: CallOptions): Promise<string>;
  json<Schema extends z.ZodType>(schema: Schema, args: readonly string[], options?: CallOptions): Promise<z.output<Schema>>;
};

export function createCli(options: CliOptions): Cli {
  const text = async (args: readonly string[], call: CallOptions = {}) => {
    const binary = await options.binary();
    const result = await options.run({
      file: binary,
      args,
      env: options.env,
      timeoutMs: call.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      ...(call.input === undefined ? {} : { input: call.input }),
    });
    if (result.spawnError !== null) {
      if (/ENOENT|EACCES/.test(result.spawnError)) {
        throw new ForgeError(
          `Could not run ${options.name} at "${binary}" (${result.spawnError}). Set the ${options.name} path in the Guided Review settings.`,
        );
      }
      throw new ForgeError(`${options.name} did not finish: ${result.spawnError}.`);
    }
    if (result.exitCode !== 0) {
      throw new ForgeError(`${options.name} failed: ${reason(result.stderr, options.name) ?? `exit code ${result.exitCode}`}`);
    }
    return result.stdout;
  };

  return {
    text,
    async json(schema, args, call) {
      const stdout = await text(args, call);
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        throw new ForgeError(`${options.name} answered with something that is not JSON.`);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new ForgeError(`${options.name} answered in a shape this plugin does not know: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
      }
      return parsed.data;
    },
  };
}

/** The CLI's own words, without its `gh:` prefix and without whatever it printed after the first line. */
function reason(stderr: string, name: string): string | null {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) return null;
  return line.startsWith(`${name}: `) ? line.slice(name.length + 2) : line;
}
