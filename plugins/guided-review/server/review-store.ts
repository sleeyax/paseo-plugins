import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewHeader } from "../shared/contracts.ts";
import type { ChangeRequest, ChangeRequestRef, ForgeUser } from "./forge/port.ts";
import type { ReviewWorkspace } from "./workspaces/port.ts";

/** One change request under review, and the workspace its guide lives in. */
export type ReviewRecord = {
  id: string;
  ref: ChangeRequestRef;
  workspace: ReviewWorkspace;
  header: ReviewHeader;
  /** Who the forge CLI was logged in as, which decides the verdicts on offer. */
  viewer: ForgeUser;
  updatedAt: string;
};

const RECORD_FILE = "review.json";

/**
 * A review's ID is its path under `reviews/`: forge, host, project and number, lower-cased because
 * both forges treat the project path case-insensitively. Guides, progress and draft links for the
 * same review go in the same directory, keyed further by head SHA.
 */
export function reviewIdOf(ref: ChangeRequestRef): string {
  const segments = [ref.forge, ref.host, ...ref.project.split("/"), String(ref.number)].map((segment) => segment.toLowerCase());
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new Error(`Cannot keep a review for ${ref.url}: "${segment}" is not a usable path segment.`);
    }
  }
  return segments.join("/");
}

/**
 * The reviews on disk under the plugin's data directory, indexed in memory on first use. This process
 * is the only writer, so the index stays true once built.
 */
export class ReviewStore {
  readonly #reviews: string;
  #index: Promise<Map<string, ReviewRecord>> | null = null;

  constructor(dataDirectory: string) {
    this.#reviews = path.join(dataDirectory, "reviews");
  }

  directoryOf(id: string): string {
    return path.join(this.#reviews, ...id.split("/"));
  }

  async get(id: string): Promise<ReviewRecord | null> {
    return (await this.#load()).get(id) ?? null;
  }

  async findByWorkspace(workspaceId: string): Promise<ReviewRecord | null> {
    for (const record of (await this.#load()).values()) {
      if (record.workspace.id === workspaceId) return record;
    }
    return null;
  }

  /** Records the review, and keeps what the forge said at this head SHA for the guide to be built from. */
  async save(record: ReviewRecord, changeRequest: ChangeRequest): Promise<void> {
    const directory = this.directoryOf(record.id);
    await writeJson(path.join(directory, "snapshots", `${changeRequest.headSha}.json`), changeRequest);
    await writeJson(path.join(directory, RECORD_FILE), record);
    (await this.#load()).set(record.id, record);
  }

  #load(): Promise<Map<string, ReviewRecord>> {
    this.#index ??= this.#scan();
    return this.#index;
  }

  async #scan(): Promise<Map<string, ReviewRecord>> {
    const index = new Map<string, ReviewRecord>();
    let entries: string[];
    try {
      entries = await readdir(this.#reviews, { recursive: true });
    } catch {
      return index;
    }
    for (const entry of entries) {
      if (path.basename(entry) !== RECORD_FILE) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.#reviews, entry), "utf8")) as ReviewRecord;
        // A file that is not where its ID says is someone else's doing; the ID is what the index trusts.
        if (typeof record.id === "string" && this.directoryOf(record.id) === path.join(this.#reviews, path.dirname(entry))) {
          index.set(record.id, record);
        }
      } catch {
        // A record that cannot be read is a review the reviewer can start again.
      }
    }
    return index;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}
