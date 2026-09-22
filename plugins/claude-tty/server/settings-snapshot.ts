import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { settingsDocument } from "../shared/settings.ts";
import { messageOf } from "./checkout.ts";
import type { Settings } from "./settings.ts";

/**
 * What the adapter is handed as `--settings-file`, with every choice already resolved, so it needs
 * neither this plugin's schema nor its defaults. `apps/claude-tty-acp/src/settings-document.ts` reads
 * it; a null `bypassAutoAccept` is a Bypass Permissions session following `autoAccept`.
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
  /** Writes the document as it stands now; never rejects, since a session must not fail over it. */
  refresh(): Promise<void>;
  stop(): void;
};

/**
 * Keeps the snapshot in step with the host's document: once per `refresh`, and on every change the
 * store announces, which is what reaches sessions that are already open.
 *
 * Every write reads the document afresh and they run one at a time, so the last write is always of the
 * latest document whatever order the triggers arrived in. An invalid document leaves the last good
 * snapshot where it is: an approval is not something to change over a document nobody can read.
 */
export function mirrorSettings(settings: Settings, filePath: string): SettingsMirror {
  let queue = Promise.resolve();
  const refresh = () => {
    queue = queue.then(() => writeSnapshot(settings, filePath));
    return queue;
  };
  const unsubscribe = settings.subscribe(() => void refresh());
  return { refresh, stop: unsubscribe };
}

async function writeSnapshot(settings: Settings, filePath: string): Promise<void> {
  try {
    const state = await settings.read();
    if (state.status !== "ready") {
      console.warn(`[claude-tty] Kept the adapter's last settings, because the saved ones are invalid: ${state.error}`);
      return;
    }
    await writeAtomically(filePath, `${JSON.stringify(snapshotOf(state.values))}\n`);
  } catch (error) {
    console.warn(`[claude-tty] Could not hand the adapter its settings at ${filePath}: ${messageOf(error)}`);
  }
}

/** Renamed into place, so the adapter never reads half a file. */
async function writeAtomically(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}
