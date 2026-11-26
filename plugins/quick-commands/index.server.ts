import { spawnProcess, type PluginServerContext, type PluginSettingsState } from "@getpaseo/plugin/server";
import os from "node:os";
import { join } from "node:path";
import { CommandRuns, type Launch } from "./server/command-runs.ts";
import { dataDirectory } from "./server/paths.ts";
import { createRunStore } from "./server/run-store.ts";
import { loginShell, shellArgs } from "./server/shell.ts";
import { commandsDocument, type Command } from "./shared/commands.ts";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ID } from "./shared/identity.ts";

const OK = { ok: true } as const;
/** Output can arrive in many small chunks; each subscriber gets at most one state per this window. */
const PUSH_INTERVAL_MS = 150;
const UNSUPPORTED = process.platform === "win32" ? "Quick Commands does not support Windows hosts yet." : null;

export default function contribute(server: PluginServerContext) {
  const log = (message: string) => console.warn(`${PLUGIN_ID}: ${message}`);
  const settings = server.registerSettings(commandsDocument);

  const shell = loginShell();
  // Its own process group, so Stop reaches whatever the command started; stdin is closed so a password prompt fails instead of hanging.
  const launch: Launch = (command) =>
    spawnProcess(shell, shellArgs(command), { cwd: os.homedir(), env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const runs = new CommandRuns({ launch, store: createRunStore(join(dataDirectory(), "last-runs.json"), log), log });

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  runs.onChange(notify);

  let commands: Command[] = [];
  const applySettings = (state: PluginSettingsState<typeof commandsDocument.schema>) => {
    if (state.status !== "ready") {
      log(`ignoring invalid settings: ${state.error}`);
      return;
    }
    commands = state.values.commands;
    runs.retain(commands.map((command) => command.id));
    notify();
  };
  const removeSettingsListener = settings.subscribe(applySettings);
  const loaded = (async () => {
    try {
      await runs.load();
      applySettings(await settings.read());
    } catch (error) {
      log(`could not load: ${String(error)}`);
    }
  })();

  const hostState = (): contracts.HostState =>
    UNSUPPORTED ? { kind: "unsupported", message: UNSUPPORTED } : { kind: "ready", commands, runs: runs.snapshot() };

  const commandWithId = async (commandId: string): Promise<Command> => {
    if (UNSUPPORTED) throw new Error(UNSUPPORTED);
    await loaded;
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) throw new Error("This command no longer exists.");
    return command;
  };

  // A handler that returns a promise closes the subscription when it settles, so this one returns nothing.
  server.handle(contracts.watchHost, (_input, { push, signal }) => {
    let timer: NodeJS.Timeout | null = null;
    const send = () => {
      timer = null;
      push(hostState()).catch((error: unknown) => log(`could not push the state: ${String(error)}`));
    };
    const schedule = () => {
      timer ??= setTimeout(send, PUSH_INTERVAL_MS);
    };
    signal.addEventListener(
      "abort",
      () => {
        listeners.delete(schedule);
        if (timer) clearTimeout(timer);
      },
      { once: true },
    );
    void loaded.then(() => {
      if (signal.aborted) return;
      listeners.add(schedule);
      send();
    });
  });

  server.handle(contracts.runCommand, async ({ commandId }) => {
    runs.start(await commandWithId(commandId));
    return OK;
  });

  server.handle(contracts.stopCommand, async ({ commandId }) => {
    await loaded;
    runs.stop(commandId);
    return OK;
  });

  return async () => {
    removeSettingsListener();
    listeners.clear();
    await runs.flush();
  };
}
