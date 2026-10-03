import type { ForgeUser } from "./port.ts";

/** What both forge adapters share: the caps on what they read, and how an author with no account reads. */

/** Cloning a large repository is the one call that can take minutes. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Enough to understand a change; the guide does not need a hundred-and-first commit's message. */
export const MAX_COMMITS = 100;
export const MAX_LINKED_ISSUES = 25;
/** More open change requests from one branch than anyone would choose between. */
export const MAX_BRANCH_CHANGE_REQUESTS = 20;

/** What both forges show as the author of a change request whose account was deleted. */
export const GHOST: ForgeUser = { login: "ghost", name: null };

/** An author as the forge gave one, or the ghost when it gave none, as for a deleted account. */
export function userOf(author: { login: string; name?: string | null | undefined } | null | undefined): ForgeUser {
  return author ? { login: author.login, name: author.name ?? null } : GHOST;
}
