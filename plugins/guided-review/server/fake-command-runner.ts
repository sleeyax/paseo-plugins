import type { CommandRequest, CommandResult, CommandRunner } from "./command-runner.ts";

/** What a scripted call answers; anything left out reads as a clean, silent exit. */
export type ScriptedResult = Partial<CommandResult>;

/**
 * A command runner that replays recorded output in order and records every request it was given,
 * so a test asserts the invocations. A call beyond the script fails the way a missing binary would.
 */
export type FakeCommandRunner = CommandRunner & { calls: CommandRequest[] };

export function fakeCommandRunner(script: readonly ScriptedResult[]): FakeCommandRunner {
  const pending = [...script];
  const calls: CommandRequest[] = [];
  const run = (async (request: CommandRequest) => {
    calls.push(request);
    const next = pending.shift();
    if (next === undefined) {
      return { exitCode: null, stdout: "", stderr: "", spawnError: `Unscripted call: ${request.file} ${request.args.join(" ")}` };
    }
    return { exitCode: 0, stdout: "", stderr: "", spawnError: null, ...next };
  }) as FakeCommandRunner;
  run.calls = calls;
  return run;
}
