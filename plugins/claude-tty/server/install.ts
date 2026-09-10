import type { PaseoApi } from "@getpaseo/client";
import {
  startJob,
  withStepRunning,
  withStepSettled,
  type InstallJob,
  type InstallStepId,
  type StepOutcome,
} from "../shared/install.ts";
import { failedChecks, parseDiagnosticsReport } from "./diagnostics.ts";
import { ADAPTER_PACKAGE, adapterBinaryPath, adapterEntryPath } from "./paths.ts";
import { PROVIDER_ID, classifyProviderEntry, providerEntryFor } from "./provider.ts";
import { runCommand } from "./exec.ts";
import { fileExists, firstExecutable, messageOf, resolveRepoRoot } from "./checkout.ts";
import { readProviderEntry } from "./status.ts";

const DIAGNOSE_TIMEOUT_MS = 60_000;

/**
 * The job outlives the request that starts it, so it lives here and is polled.
 * Module scope is the only state a plugin process has that survives between RPC calls.
 */
let job: InstallJob | null = null;
let active = false;

export function currentInstall(): InstallJob | null {
  return job;
}

export function startInstall(paseo: PaseoApi, options: { repair: boolean }): InstallJob {
  if (active && job) return job;
  active = true;
  job = startJob(Date.now());
  void runInstall(paseo, options).finally(() => {
    active = false;
  });
  return job;
}

async function runInstall(paseo: PaseoApi, options: { repair: boolean }): Promise<void> {
  const repo = await step("repo", async () => {
    const resolved = await resolveRepoRoot(paseo);
    return resolved.root === null
      ? { ok: false, detail: resolved.problem }
      : { ok: true, detail: resolved.root, value: resolved.root };
  });
  if (repo === null) return;

  const built = await step("adapter", async () => {
    if (!(await fileExists(adapterEntryPath(repo)))) {
      return {
        ok: false,
        detail: `The adapter is not built. Run "pnpm install --frozen-lockfile" and "pnpm --filter ${ADAPTER_PACKAGE} build" in ${repo}, then install again.`,
      };
    }
    const binary = await firstExecutable([adapterBinaryPath(repo)]);
    return binary === null
      ? { ok: false, detail: `${adapterBinaryPath(repo)} is not executable.` }
      : { ok: true, detail: binary, value: binary };
  });
  if (built === null) return;

  const diagnosed = await step("diagnose", async () => {
    const result = await runCommand(built, ["--diagnose", "--json"], { cwd: repo, timeoutMs: DIAGNOSE_TIMEOUT_MS });
    if (result.spawnError !== null) return outcomeOf(result, "--diagnose --json");
    const report = parseDiagnosticsReport(result.stdout);
    if (report === null) {
      return { ...outcomeOf(result, "The adapter did not report its checks as JSON."), ok: false };
    }
    const failures = failedChecks(report);
    return {
      ok: report.ok,
      detail: report.ok
        ? report.checks.map((check) => check.label).join(", ")
        : failures.map((check) => `${check.label}: ${check.detail}`).join("\n"),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      value: report,
    };
  });
  if (diagnosed === null) return;

  const registered = await step("register", async () => {
    const expected = providerEntryFor(repo);
    const existing = await readProviderEntry(paseo);
    const state = classifyProviderEntry(existing, expected);
    if (state === "matching") return { ok: true, detail: `"${PROVIDER_ID}" already points at this checkout`, value: state };
    if (state === "foreign") {
      return {
        ok: false,
        detail: `The provider ID "${PROVIDER_ID}" is already configured as something this plugin did not register. Remove it from the daemon configuration by hand before installing.`,
      };
    }
    if (state === "mismatched" && !options.repair) {
      return {
        ok: false,
        detail: `"${PROVIDER_ID}" is registered but does not point at this checkout. Repointing it is a separate, explicit action.`,
      };
    }
    try {
      // deepMerge keeps keys the canonical entry does not have, so a repair drops the old entry first.
      if (state === "mismatched") await paseo.config.patch({ removeProviders: [PROVIDER_ID] });
      await paseo.config.patch({ providers: { [PROVIDER_ID]: expected } });
    } catch (error) {
      return { ok: false, detail: `The daemon rejected the provider entry: ${messageOf(error)}` };
    }
    return { ok: true, detail: `"${PROVIDER_ID}" now points at ${expected.command[0]}`, value: state };
  });
  if (registered === null) return;

  await step("refresh", async () => {
    try {
      await paseo.providers.refresh();
    } catch (error) {
      return { ok: false, detail: `Paseo did not re-probe its providers: ${messageOf(error)}` };
    }
    return { ok: true, detail: "Paseo re-probed its providers", value: true };
  });
}

/** Runs one step against the module-scope job and returns its value, or null once the job has failed. */
async function step<Value>(id: InstallStepId, run: () => Promise<StepOutcome & { value?: Value }>): Promise<Value | null> {
  job = withStepRunning(job!, id);
  let outcome: StepOutcome & { value?: Value };
  try {
    outcome = await run();
  } catch (error) {
    outcome = { ok: false, detail: messageOf(error) };
  }
  job = withStepSettled(job, id, outcome, Date.now());
  return outcome.ok ? (outcome.value as Value) : null;
}

function outcomeOf(
  result: { exitCode: number | null; stdout: string; stderr: string; spawnError: string | null },
  what: string,
): StepOutcome {
  if (result.spawnError !== null) {
    return { ok: false, detail: `${what} could not run: ${result.spawnError}`, stdout: result.stdout, stderr: result.stderr, exitCode: null };
  }
  return {
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? what : `${what} exited ${result.exitCode}`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
