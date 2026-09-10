import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { UninstallPayload } from "../shared/contracts.ts";
import { defaultStateDirectory } from "./paths.ts";
import { PROVIDER_ID, classifyProviderEntry, providerEntryFor } from "./provider.ts";
import { messageOf, resolveRepoRoot } from "./checkout.ts";
import { listSessions } from "./sessions.ts";
import { readProviderEntry } from "./status.ts";

/**
 * Undoes what this plugin did and nothing else: the provider entry it wrote, and the state directory
 * only when asked. The checkout it was installed from is never touched.
 */
export async function runUninstall(paseo: PaseoApi, options: { removeState: boolean }): Promise<UninstallPayload> {
  const stateDirectory = defaultStateDirectory();
  if (options.removeState) {
    const held = (await listSessions(paseo)).sessions.filter((session) => session.lock?.live === true);
    if (held.length > 0) {
      const subject = held.length === 1 ? "A session is still open" : `${held.length} sessions are still open`;
      throw new Error(`${subject} on this host. Close ${held.length === 1 ? "it" : "them"} before removing ${stateDirectory}.`);
    }
  }

  const notes: string[] = [];
  const removedProvider = await removeProvider(paseo, notes);

  let removedState = false;
  if (options.removeState) {
    try {
      await rm(stateDirectory, { recursive: true, force: true });
      removedState = true;
      notes.push(`Removed ${stateDirectory}.`);
    } catch (error) {
      notes.push(`Could not remove ${stateDirectory}: ${messageOf(error)}`);
    }
  } else {
    notes.push(`Kept ${stateDirectory}, so saved sessions still resume after a reinstall.`);
  }

  return { removedProvider, removedState, detail: notes.join("\n") };
}

async function removeProvider(paseo: PaseoApi, notes: string[]): Promise<boolean> {
  const repo = await resolveRepoRoot(paseo);
  const existing = await readProviderEntry(paseo);
  if (repo.root === null) {
    notes.push(`Left "${PROVIDER_ID}" alone: ${repo.problem}`);
    return false;
  }
  const state = classifyProviderEntry(existing, providerEntryFor(repo.root));
  if (state === "absent") {
    notes.push(`"${PROVIDER_ID}" was not registered.`);
    return false;
  }
  if (state !== "matching") {
    notes.push(`Left "${PROVIDER_ID}" alone: it does not point at this checkout, so removing it would break whatever does.`);
    return false;
  }
  await paseo.config.patch({ removeProviders: [PROVIDER_ID] });
  await paseo.providers.refresh().catch(() => undefined);
  notes.push(`Removed the "${PROVIDER_ID}" provider.`);
  return true;
}
