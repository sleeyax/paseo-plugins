import type { ForgeUser } from "./port.ts";

/** What both forge adapters share: the caps on what they read, and how an author with no account reads. */

/** Cloning a large repository is the one call that can take minutes. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Enough to understand a change; the guide does not need a hundred-and-first commit's message. */
export const MAX_COMMITS = 100;
export const MAX_LINKED_ISSUES = 25;
/** More open change requests from one branch than anyone would choose between. */
export const MAX_BRANCH_CHANGE_REQUESTS = 20;

/** How many reads a call that takes one per commit has out at once. */
export const COMMIT_READS_AT_ONCE = 6;

/** `map` over `items`, at most `limit` at a time, in `items`' order. */
export async function mapAtMost<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** What both forges show as the author of a change request whose account was deleted. */
export const GHOST: ForgeUser = { login: "ghost", name: null };

/** An author as the forge gave one, or the ghost when it gave none, as for a deleted account. */
export function userOf(author: { login: string; name?: string | null | undefined } | null | undefined): ForgeUser {
  return author ? { login: author.login, name: author.name ?? null } : GHOST;
}
