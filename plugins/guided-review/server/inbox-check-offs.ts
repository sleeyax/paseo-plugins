import path from "node:path";
import type { z } from "zod";
import {
  AuthoredCheckOffSchema,
  CheckOffSchema,
  type AuthoredCheckOff,
  type CheckOff,
  type ReviewerState,
  type ReviewRequest,
  type ListedHost,
} from "../shared/inbox.ts";
import { byTab } from "./inbox-tabs.ts";
import { readJson, writeJson } from "./json-file.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";

const FILE = "inbox-check-offs.json";

/** Each tab's check-offs by the change request's URL, kept apart so a check-off on one tab leaves the other alone. */
type CheckOffs = { assigned: AssignedCheckOffs; authored: Record<string, AuthoredCheckOff> };
type AssignedCheckOffs = Record<string, CheckOff>;

/** The states only the other side brings about: being asked again, or an approval taken back. */
const RETURNING_STATES: readonly ReviewerState[] = ["requested", "unapproved"];

/**
 * What the reviewer checked off the review list, which the forge knows nothing of.
 * A check-off holds only until the change request moves on, so each listing is followed to drop those that came back or left the list.
 */
export class InboxCheckOffsFile {
  readonly #file: string;
  readonly #changes = oneAtATimePer<string>();

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, FILE);
  }

  async set(url: string, checkOff: CheckOff | null): Promise<void> {
    await this.#change((checkOffs) => {
      const { [url]: _, ...rest } = checkOffs.assigned;
      return { ...checkOffs, assigned: checkOff === null ? rest : { ...rest, [url]: checkOff } };
    });
  }

  /** Follows a listing of every host, and answers the URLs still checked off. */
  async follow(hosts: readonly ListedHost[]): Promise<Set<string>> {
    const followed = await this.#change((checkOffs) => ({ ...checkOffs, assigned: followListing(checkOffs.assigned, hosts) }));
    return new Set(Object.keys(followed.assigned));
  }

  async #read(): Promise<CheckOffs> {
    const stored = byTab(await readJson<unknown>(this.#file));
    return { assigned: byUrl(stored.assigned, CheckOffSchema), authored: byUrl(stored.authored, AuthoredCheckOffSchema) };
  }

  async #change(update: (checkOffs: CheckOffs) => CheckOffs): Promise<CheckOffs> {
    return this.#changes(FILE, async () => {
      const before = await this.#read();
      const after = update(before);
      if (JSON.stringify(after) !== JSON.stringify(before)) await writeJson(this.#file, after);
      return after;
    });
  }
}

/**
 * Drops the check-offs whose change request came back, and those a host listed in full no longer has.
 * The rest keep the state the reviewer is now in, so one they moved on themselves, by commenting, still comes back when they are asked again.
 */
function followListing(checkOffs: AssignedCheckOffs, hosts: readonly ListedHost[]): AssignedCheckOffs {
  const requests = new Map(hosts.flatMap((host) => host.requests.map((request) => [request.url, request] as const)));
  const complete = new Set<string | null>(hosts.filter((host) => host.error === null && !host.truncated).map((host) => host.host));
  const followed: AssignedCheckOffs = {};
  for (const [url, checkOff] of Object.entries(checkOffs)) {
    const request = requests.get(url);
    if (request === undefined) {
      if (!complete.has(hostOf(url))) followed[url] = checkOff;
    } else if (!cameBack(checkOff, request)) {
      followed[url] = { headSha: checkOff.headSha, state: request.state };
    }
  }
  return followed;
}

function cameBack(checkOff: CheckOff, request: ReviewRequest): boolean {
  const pushed = request.headSha !== "" && request.headSha !== checkOff.headSha;
  return pushed || (RETURNING_STATES.includes(request.state) && request.state !== checkOff.state);
}

/** One tab's check-offs as the file holds them, leaving out any the plugin no longer reads. */
function byUrl<T>(stored: unknown, schema: z.ZodType<T>): Record<string, T> {
  if (typeof stored !== "object" || stored === null) return {};
  const checkOffs: Record<string, T> = {};
  for (const [url, value] of Object.entries(stored)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) checkOffs[url] = parsed.data;
  }
  return checkOffs;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
