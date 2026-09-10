import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { settingsFilePath } from "./paths.ts";
import { PROVIDER_ID, providerEntryFor } from "./provider.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_ENV } from "../shared/settings.ts";
import { updateSettings } from "./settings.ts";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

function paseoWith(provider: unknown): PaseoApi {
  return {
    config: {
      get: async () => ({ config: { plugins: { "claude-tty": { path: pluginRoot } }, providers: { [PROVIDER_ID]: provider } } }),
      patch: async () => assert.fail("a preference must not rewrite the daemon configuration"),
    },
    providers: { refresh: async () => assert.fail("a preference must not re-probe the provider") },
  } as unknown as PaseoApi;
}

async function withCache(run: () => Promise<void>): Promise<void> {
  const cache = await mkdtemp(path.join(os.tmpdir(), "claude-tty-settings-"));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    await rm(cache, { force: true, recursive: true });
  }
}

test("saves the timeout to the plugin's own settings file", async () => {
  await withCache(async () => {
    const status = await updateSettings(paseoWith(providerEntryFor(repoRoot)), 7_200_000);

    assert.equal(status.settings.idleTimeoutMs, 7_200_000);
    assert.equal(status.settings.file, settingsFilePath());
    assert.equal(status.settings.envOverrideMs, null);
    assert.equal(status.provider.state, "matching");
    assert.deepEqual(JSON.parse(await readFile(settingsFilePath(), "utf8")), { version: 1, settings: { idleTimeoutMs: 7_200_000 } });
  });
});

test("saves the preference whatever the provider entry is doing", async () => {
  await withCache(async () => {
    // A preference is the plugin's own; it does not wait on the provider being installed or repaired.
    const status = await updateSettings(paseoWith({ extends: "acp", command: ["/usr/bin/trae"] }), 900_000);
    assert.equal(status.settings.idleTimeoutMs, 900_000);
    assert.equal(status.provider.state, "foreign");
  });
});

test("reports an entry that pins the timeout in env, which the adapter honours over this setting", async () => {
  await withCache(async () => {
    const pinned = { ...providerEntryFor(repoRoot), env: { [IDLE_TIMEOUT_ENV]: "60000" } };
    const status = await updateSettings(paseoWith(pinned), 900_000);
    assert.equal(status.settings.idleTimeoutMs, 900_000);
    assert.equal(status.settings.envOverrideMs, 60_000);
  });
});

test("refuses a timeout that is not a whole number of milliseconds in range", async () => {
  await withCache(async () => {
    const paseo = paseoWith(providerEntryFor(repoRoot));
    await assert.rejects(updateSettings(paseo, -1), /integer from 0/);
    await assert.rejects(updateSettings(paseo, 1.5), /integer from 0/);
    await assert.rejects(updateSettings(paseo, 2_147_483_648), /integer from 0/);
  });
});

test("reads back the default until something is saved", async () => {
  await withCache(async () => {
    const status = await updateSettings(paseoWith(providerEntryFor(repoRoot)), DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(status.settings.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  });
});
