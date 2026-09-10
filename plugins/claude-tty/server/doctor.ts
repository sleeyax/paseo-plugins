import os from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import type { DoctorPayload } from "../shared/contracts.ts";
import { parseDiagnosticsReport } from "./diagnostics.ts";
import { adapterBinaryPath } from "./paths.ts";
import { PROVIDER_ID, commandOf } from "./provider.ts";
import { runCommand } from "./exec.ts";
import { messageOf, resolveRepoRoot } from "./checkout.ts";
import { readProviderEntry } from "./status.ts";

const DIAGNOSE_TIMEOUT_MS = 60_000;

/** Kept so a report run from the command centre is still there when the surface opens. */
let lastReport: DoctorPayload | null = null;

export function lastDoctorReport(): DoctorPayload | null {
  return lastReport;
}

export async function runDoctor(paseo: PaseoApi): Promise<DoctorPayload> {
  const [repo, existing] = await Promise.all([resolveRepoRoot(paseo), readProviderEntry(paseo)]);
  /** What the daemon would launch, which is the only executable worth diagnosing. */
  const binary = commandOf(existing)?.[0] ?? (repo.root === null ? null : adapterBinaryPath(repo.root));
  const [adapter, daemon] = await Promise.all([
    checkAdapter(binary, repo.root ?? os.tmpdir()),
    readDaemonDiagnostic(paseo),
  ]);
  lastReport = { ranAt: Date.now(), adapter: { binary, ...adapter }, daemon };
  return lastReport;
}

async function checkAdapter(binary: string | null, cwd: string): Promise<Omit<DoctorPayload["adapter"], "binary">> {
  if (binary === null) return { ok: false, problem: "There is no adapter to diagnose yet.", checks: [] };
  const result = await runCommand(binary, ["--diagnose", "--json"], { cwd, timeoutMs: DIAGNOSE_TIMEOUT_MS });
  if (result.spawnError !== null) return { ok: false, problem: `${binary} could not run: ${result.spawnError}`, checks: [] };
  const report = parseDiagnosticsReport(result.stdout);
  if (report === null) {
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part !== "").join("\n");
    return {
      ok: false,
      problem: `${binary} did not report its checks as JSON${result.exitCode === null ? "" : ` and exited ${result.exitCode}`}.${output === "" ? "" : `\n${output}`}`,
      checks: [],
    };
  }
  return { ok: report.ok, problem: null, checks: report.checks };
}

async function readDaemonDiagnostic(paseo: PaseoApi): Promise<DoctorPayload["daemon"]> {
  try {
    const payload = await paseo.providers.diagnostic(PROVIDER_ID);
    return { diagnostic: payload.diagnostic, error: null };
  } catch (error) {
    return { diagnostic: null, error: messageOf(error) };
  }
}

