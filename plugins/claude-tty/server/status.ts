import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { adapterBinaryPath, adapterEntryPath, claudeCandidates, defaultStateDirectory, settingsFilePath } from "./paths.ts";
import { PROVIDER_ID, classifyProviderEntry, commandOf, envOf, providerEntryFor } from "./provider.ts";
import { IDLE_TIMEOUT_ENV, parseIdleTimeout } from "../shared/settings.ts";
import { fileExists, firstExecutable, resolveRepoRoot } from "./checkout.ts";
import { readSettings } from "./settings-store.ts";

export async function readStatus(paseo: PaseoApi): Promise<StatusPayload> {
  const [repo, claudeBinary, saved] = await Promise.all([resolveRepoRoot(paseo), firstExecutable(claudeCandidates()), readSettings()]);
  const host = { node: process.version, claude: claudeBinary };
  const stateDirectory = defaultStateDirectory();
  const file = settingsFilePath();

  if (repo.root === null) {
    return {
      repoRoot: null,
      problem: repo.problem,
      adapter: { binary: null, built: false },
      provider: { id: PROVIDER_ID, state: "absent", label: null, command: null, expectedCommand: null },
      host,
      stateDirectory,
      settings: { idleTimeoutMs: saved.idleTimeoutMs, file, envOverrideMs: null },
    };
  }

  const [built, existing] = await Promise.all([fileExists(adapterEntryPath(repo.root)), readProviderEntry(paseo)]);
  const expected = providerEntryFor(repo.root);

  return {
    repoRoot: repo.root,
    problem: null,
    adapter: { binary: adapterBinaryPath(repo.root), built },
    provider: {
      id: PROVIDER_ID,
      state: classifyProviderEntry(existing, expected),
      label: labelOf(existing),
      command: commandOf(existing),
      expectedCommand: expected.command,
    },
    host,
    stateDirectory,
    settings: { idleTimeoutMs: saved.idleTimeoutMs, file, envOverrideMs: envOverrideOf(existing) },
  };
}

/**
 * The adapter lets the environment variable win, so an entry that sets it makes the saved value moot.
 * A variable set on the daemon's own process is invisible from here and is not reported.
 */
function envOverrideOf(entry: unknown): number | null {
  const raw = envOf(entry)?.[IDLE_TIMEOUT_ENV];
  return raw === undefined ? null : parseIdleTimeout(raw);
}

export async function readProviderEntry(paseo: PaseoApi): Promise<unknown> {
  const { config } = await paseo.config.get();
  return config.providers?.[PROVIDER_ID];
}

function labelOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const label = (entry as { label?: unknown }).label;
  return typeof label === "string" ? label : null;
}
