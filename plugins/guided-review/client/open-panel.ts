export type OpenPanelOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Opens a panel in a workspace the app may not have heard of yet. `client.openPanel` throws until the
 * workspace is in the app's cache, and a workspace the daemon has just created reaches it a moment
 * later, so the call is retried for a while. False when it never took.
 */
export async function openPanelWhenReady(open: () => void, options: OpenPanelOptions = {}): Promise<boolean> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      open();
      return true;
    } catch {
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  return false;
}
