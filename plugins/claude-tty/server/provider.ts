import path from "node:path";
import { ADAPTER_BINARY_NAME, adapterBinaryPath } from "./paths.ts";

/**
 * Paseo special-cases this ID when listing an ACP provider's slash commands, which is the only
 * reason the adapter borrows it. The adapter README explains what that costs.
 */
export const PROVIDER_ID = "traecli";

export const PROVIDER_LABEL = "Claude TTY";

export type ProviderEntry = {
  extends: "acp";
  label: string;
  command: string[];
  params: { supportsMcpServers: boolean };
};

export function providerEntryFor(repoRoot: string): ProviderEntry {
  return {
    extends: "acp",
    label: PROVIDER_LABEL,
    command: [adapterBinaryPath(repoRoot)],
    params: { supportsMcpServers: false },
  };
}

/**
 * `CLAUDE_BIN`, `CLAUDE_CONFIG_DIR` and the idle timeout are all documented as things a host may set
 * on this entry, so `env` belongs to whoever set it: the plugin neither writes it nor compares it.
 */
export function envOf(entry: unknown): Record<string, string> | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const env = (entry as { env?: unknown }).env;
  if (env === null || env === undefined || typeof env !== "object" || Array.isArray(env)) return null;
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

export type ProviderState =
  /** Nothing holds the ID, so registering is a pure addition. */
  | "absent"
  /** This checkout's adapter, configured the way the plugin would configure it. */
  | "matching"
  /** Recognisably this adapter, but pointed elsewhere or configured differently. */
  | "mismatched"
  /** Something else owns the ID; the plugin never writes over it. */
  | "foreign";

export function classifyProviderEntry(existing: unknown, expected: ProviderEntry): ProviderState {
  if (existing === undefined || existing === null) return "absent";
  const command = commandOf(existing);
  const executable = command?.[0];
  if (executable === undefined) return "foreign";
  if (path.basename(executable) !== ADAPTER_BINARY_NAME) return "foreign";
  return isCanonical(existing, expected) ? "matching" : "mismatched";
}

export function commandOf(entry: unknown): string[] | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const command = (entry as { command?: unknown }).command;
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) return null;
  return command as string[];
}

/** `label` and `env` are the user's to set, so neither is compared. */
function isCanonical(entry: unknown, expected: ProviderEntry): boolean {
  const record = entry as Record<string, unknown>;
  const command = commandOf(entry);
  const params = record.params;
  return (
    record.extends === expected.extends &&
    command !== null &&
    command.length === expected.command.length &&
    command.every((part, index) => path.resolve(part) === path.resolve(expected.command[index]!)) &&
    typeof params === "object" &&
    params !== null &&
    (params as Record<string, unknown>).supportsMcpServers === expected.params.supportsMcpServers
  );
}
