import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { settingsDocument } from "../shared/settings.ts";
import { messageOf } from "./checkout.ts";
import type { Settings } from "./settings.ts";

/**
 * What the adapter reads from `--settings-file`, resolved so it needs neither this schema nor its defaults.
 * A null `bypassAutoAccept` means Bypass Permissions sessions follow `autoAccept`.
 */
export type SettingsSnapshot = {
  idleTimeoutMs: number;
  autoAccept: boolean;
  bypassAutoAccept: boolean | null;
};

export function snapshotOf(values: z.output<typeof settingsDocument.schema>): SettingsSnapshot {
  return {
    idleTimeoutMs: values.idleTimeoutMs,
    autoAccept: values.autoAccept,
    bypassAutoAccept: values.bypassAutoAccept === "inherit" ? null : values.bypassAutoAccept === "on",
  };
}

export type SettingsMirror = {
  /** Never rejects, so a session never fails over the snapshot. */
  refresh(): Promise<void>;
  stop(): void;
};

/**
 * Rewrites the snapshot on every `refresh` and every change the store announces.
 * Writes run one at a time and each reads the settings afresh, so the last write always has the latest values.
 * An invalid document keeps the last good snapshot, so a bad save can't change an approval.
 * Only `refresh` creates the directory, so a settings change doesn't undo **Remove state**.
 */
export function mirrorSettings(settings: Settings, filePath: string): SettingsMirror {
  let queue = Promise.resolve();
  const write = (createDirectory: boolean) => {
    queue = queue.then(() => writeSnapshot(settings, filePath, createDirectory));
    return queue;
  };
  const unsubscribe = settings.subscribe(() => write(false));
  return { refresh: () => write(true), stop: unsubscribe };
}

async function writeSnapshot(settings: Settings, filePath: string, createDirectory: boolean): Promise<void> {
  try {
    const state = await settings.read();
    if (state.status !== "ready") {
      console.warn(`[claude-tty] Kept the adapter's last settings, because the saved ones are invalid: ${state.error}`);
      return;
    }
    if (createDirectory) await mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomically(filePath, `${JSON.stringify(snapshotOf(state.values))}\n`);
  } catch (error) {
    if (!createDirectory && (error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.warn(`[claude-tty] Could not hand the adapter its settings at ${filePath}: ${messageOf(error)}`);
  }
}

/** Renamed into place, so the adapter never reads half a file. */
async function writeAtomically(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}
