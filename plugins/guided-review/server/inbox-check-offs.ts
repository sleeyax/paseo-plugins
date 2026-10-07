import path from "node:path";
import { CheckOffSchema, type CheckOff, type ReviewerState, type ReviewRequest, type ReviewRequestHost } from "../shared/inbox.ts";
import { readJson, writeJson } from "./json-file.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";

const FILE = "inbox-check-offs.json";

/** Check-offs by the change request's URL. */
type CheckOffs = Record<string, CheckOff>;

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
      const { [url]: _, ...rest } = checkOffs;
      return checkOff === null ? rest : { ...rest, [url]: checkOff };
    });
  }

  /** Follows a listing of every host, and answers the URLs still checked off. */
  async follow(hosts: readonly ReviewRequestHost[]): Promise<Set<string>> {
    return new Set(Object.keys(await this.#change((checkOffs) => followListing(checkOffs, hosts))));
  }

  async #read(): Promise<CheckOffs> {
    const stored = await readJson<unknown>(this.#file);
    if (typeof stored !== "object" || stored === null) return {};
    const checkOffs: CheckOffs = {};
    for (const [url, value] of Object.entries(stored)) {
      const parsed = CheckOffSchema.safeParse(value);
      if (parsed.success) checkOffs[url] = parsed.data;
    }
    return checkOffs;
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
function followListing(checkOffs: CheckOffs, hosts: readonly ReviewRequestHost[]): CheckOffs {
  const requests = new Map(hosts.flatMap((host) => host.requests.map((request) => [request.url, request] as const)));
  const complete = new Set<string | null>(hosts.filter((host) => host.error === null && !host.truncated).map((host) => host.host));
  const followed: CheckOffs = {};
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

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
