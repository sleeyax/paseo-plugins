import { settingsRpc } from "@getpaseo/plugin";
import type { PluginCommandCapabilities, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import type { DetailLevel, PresenceSettings } from "../shared/presence.ts";
import { settingsDocument, withProjectDetailLevel } from "../shared/settings.ts";

const store = settingsRpc(settingsDocument.id);

/** For Command Center items, which have no React tree for `useSettings`. Retries once on a revision conflict. */
export async function updateSettings(
  rpc: PluginCommandCapabilities["rpc"],
  change: (settings: PresenceSettings) => PresenceSettings,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await rpc(store.read, {});
    if (current.status !== "ready") throw new Error(current.error);
    const values = change(settingsDocument.schema.parse(current.values));
    const result = await rpc(store.write, { revision: current.revision, values });
    if (result.status === "saved") return;
    if (result.status === "invalid") throw new Error(result.error);
  }
  throw new Error("The Discord presence settings kept changing under this save. Try again.");
}

export function setProjectLevel(
  rpc: PluginCommandCapabilities["rpc"],
  workspace: PluginWorkspaceCommandContext["workspace"],
  level: DetailLevel | null,
): Promise<void> {
  const project = { rootPath: workspace.projectRootPath, displayName: workspace.projectDisplayName };
  return updateSettings(rpc, (settings) => withProjectDetailLevel(settings, project, level));
}
