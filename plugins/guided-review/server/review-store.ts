import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewHeader } from "../shared/contracts.ts";
import type { LayeredGuide } from "../shared/guide.ts";
import type { ChangeRequest, ChangeRequestRef, ForgeUser } from "./forge/port.ts";
import type { BodyParagraph } from "./review-body.ts";
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
  /** Why the reviewer's own branch was left alone and the guide lives in a PR workspace instead. */
  note?: string;
  /**
   * The head of the guide the review had before its head moved to `header.headSha`, whose marks
   * carry over to the guide at this head once it is written. Absent until the head first moves.
   */
  previousHeadSha?: string;
};

/**
 * A review's guide at one head SHA, and where generating it has got to. Kept from the moment the
 * guide agent is asked, so a plugin restart mid-generation picks the same agent's answer up again.
 */
export type GuideRecord = {
  headSha: string;
  /** The workspace the guide agent lives in; a new workspace for the review means a new guide. */
  workspaceId: string;
  /** Null until the agent exists. */
  agentId: string | null;
  status: "generating" | "ready" | "failed";
  /** Laid out in layers and checked for coverage, as the panel shows it. */
  guide: LayeredGuide | null;
  /** Why generation failed, as a sentence. */
  message: string | null;
  updatedAt: string;
};

/**
 * What the reviewer marked understood in the guide at one head SHA: nodes by ID, since an ID means
 * something only within its guide, and Supporting and Unsorted entries by path, which mean the same
 * in any guide of the review. Carrying marks over to a later head compares the two guides' nodes.
 */
export type ProgressRecord = {
  headSha: string;
  /**
   * The guide agent whose guide the marks were made in. A guide generated again at the same head
   * has a new agent and its own node IDs, so marks made in the one before count for nothing there.
   */
  agentId: string;
  nodes: string[];
  files: string[];
  updatedAt: string;
};

/**
 * Where a draft the panel wrote came from: the node `nodeId` of the guide at `headSha` its agent
 * `agentId` wrote. Node IDs mean something only within their guide, so a link to an earlier guide
 * is followed to the node of the current one that covers the same code, as marks are carried over.
 */
export type DraftLink = { nodeId: string; headSha: string; agentId: string };

/**
 * What the plugin keeps about the reviewer's drafts, which themselves live on the forge: the node
 * each was written from, by the forge's draft ID (or a paragraph's minted one), and on GitHub the
 * node comments in the pending review's body. None of it is ever posted.
 */
export type DraftsRecord = { links: Record<string, DraftLink>; paragraphs: BodyParagraph[] };

const RECORD_FILE = "review.json";
const GUIDES = "guides";
const PROGRESS = "progress";
const REVIEW_BODY_FILE = "review-body.json";
const DRAFTS_FILE = "drafts.json";

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

  /** Records the review again, at a head `save` already kept what the forge said at. */
  async update(record: ReviewRecord): Promise<void> {
    await writeJson(path.join(this.directoryOf(record.id), RECORD_FILE), record);
    (await this.#load()).set(record.id, record);
  }

  /** What the forge said about the review at `headSha`, as `save` kept it. */
  async snapshot(id: string, headSha: string): Promise<ChangeRequest | null> {
    return readJson<ChangeRequest>(path.join(this.directoryOf(id), "snapshots", `${headSha}.json`));
  }

  async getGuide(id: string, headSha: string): Promise<GuideRecord | null> {
    return readJson<GuideRecord>(path.join(this.directoryOf(id), GUIDES, `${headSha}.json`));
  }

  async saveGuide(id: string, record: GuideRecord): Promise<void> {
    await writeJson(path.join(this.directoryOf(id), GUIDES, `${record.headSha}.json`), record);
  }

  /** The reviewer's marks in the guide at `headSha`, or null when none were ever made. */
  async getProgress(id: string, headSha: string): Promise<ProgressRecord | null> {
    return readJson<ProgressRecord>(path.join(this.directoryOf(id), PROGRESS, `${headSha}.json`));
  }

  async saveProgress(id: string, record: ProgressRecord): Promise<void> {
    await writeJson(path.join(this.directoryOf(id), PROGRESS, `${record.headSha}.json`), record);
  }

  /**
   * The review body the reviewer has written so far, for a forge that keeps none before submit
   * (GitLab); empty when there is none. It belongs to the review, not to a head.
   */
  async getReviewBody(id: string): Promise<string> {
    return (await readJson<{ body: string }>(path.join(this.directoryOf(id), REVIEW_BODY_FILE)))?.body ?? "";
  }

  async saveReviewBody(id: string, body: string): Promise<void> {
    await writeJson(path.join(this.directoryOf(id), REVIEW_BODY_FILE), { body });
  }

  /** The links and paragraphs kept for the review's drafts; none when nothing was ever kept. */
  async getDrafts(id: string): Promise<DraftsRecord> {
    const record = await readJson<Partial<DraftsRecord>>(path.join(this.directoryOf(id), DRAFTS_FILE));
    return { links: record?.links ?? {}, paragraphs: record?.paragraphs ?? [] };
  }

  async saveDrafts(id: string, record: DraftsRecord): Promise<void> {
    await writeJson(path.join(this.directoryOf(id), DRAFTS_FILE), record);
  }

  /** Every guide the review has had, one per head SHA. */
  async guides(id: string): Promise<GuideRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(path.join(this.directoryOf(id), GUIDES));
    } catch {
      return [];
    }
    const records = await Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJson<GuideRecord>(path.join(this.directoryOf(id), GUIDES, entry))),
    );
    return records.filter((record) => record !== null);
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

/** A file this process wrote, or null when it is missing or unreadable, which reads as never written. */
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}
