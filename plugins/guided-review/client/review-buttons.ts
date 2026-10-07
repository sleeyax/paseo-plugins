import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ICON, PLUGIN_ID, PLUGIN_LABEL } from "../shared/identity.ts";

const POLL_MS = 10_000;

/**
 * Keeps a header button that opens the panel on every review workspace, listed again every few seconds for reviews started since.
 * Paseo opens a workspace with the tabs it last had, and Review prepares a workspace without opening the panel in it, so a review workspace opened from Paseo's sidebar may have only its guide agent's tab.
 */
export function keepReviewButtons(client: PluginClientContext, openPanel: (workspaceId: string) => void): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const add = (workspaceId: string) =>
    client.addHeaderButton({
      id: `${PLUGIN_ID}-open-panel`,
      workspaceId,
      button: { title: `Open ${PLUGIN_LABEL}`, icon: PLUGIN_ICON, behavior: { kind: "action", onPress: () => openPanel(workspaceId) } },
    });
  const sync = async () => {
    try {
      const { workspaceIds } = await client.rpc(contracts.getReviewWorkspaces, {});
      if (!stopped) reconcileButtons(buttons, workspaceIds, add);
    } catch (error) {
      console.warn(`${PLUGIN_ID}: could not list the review workspaces: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void sync();
  const timer = setInterval(() => void sync(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    reconcileButtons(buttons, [], add);
  };
}

/** Adds a button for each of `workspaceIds` that has none and removes the buttons of workspaces no longer among them. */
export function reconcileButtons<Button extends { remove(): void }>(buttons: Map<string, Button>, workspaceIds: readonly string[], add: (workspaceId: string) => Button): void {
  const wanted = new Set(workspaceIds);
  for (const [workspaceId, button] of buttons) {
    if (wanted.has(workspaceId)) continue;
    button.remove();
    buttons.delete(workspaceId);
  }
  for (const workspaceId of wanted) {
    if (!buttons.has(workspaceId)) buttons.set(workspaceId, add(workspaceId));
  }
}
