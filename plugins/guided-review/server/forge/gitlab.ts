import { createHash } from "node:crypto";
import { z } from "zod";
import type { Draft, DraftLocation, LineRef } from "../../shared/drafts.ts";
import type { CommandRunner } from "../command-runner.ts";
import { createCli, type Cli } from "./cli.ts";
import { GITHUB_HOST } from "./github.ts";
import {
  ForgeError,
  type AnchorLine,
  type BranchChangeRequest,
  type ChangedFile,
  type ChangeRequest,
  type ChangeRequestHead,
  type ChangeRequestRef,
  type ChangeRequestState,
  type DraftAnchor,
  type DraftTarget,
  type Forge,
  type ForgeUser,
  type RepositoryRef,
} from "./port.ts";

/** Cloning a large repository is the one call that can take minutes. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** The same caps as on GitHub: enough to understand a change. */
const MAX_COMMITS = 100;
const MAX_LINKED_ISSUES = 25;
/** More open MRs from one branch than anyone would choose between. */
const MAX_BRANCH_MERGE_REQUESTS = 20;

/** No prompts, no update check and no colour codes: the output is parsed, not read. */
const GLAB_ENV = { GLAB_CHECK_UPDATE: "0", NO_PROMPT: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };

/**
 * Never passed on to `glab`. A `glab` wrapper can post as a bot account when it sees an agent's
 * environment, `PASEO_AGENT_ID` being the one Paseo sets, and a daemon restarted from an agent's
 * terminal inherits it. The review is the reviewer's own, so it is read and written as them.
 */
export const GLAB_UNSET_ENV = ["PASEO_AGENT_ID", "GITLAB_BOT_IDENTITY"] as const;

const ProjectResponse = z.object({ id: z.number() });

const MergeRequestResponse = z.object({
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  author: z.object({ username: z.string(), name: z.string().nullish() }).nullable(),
  source_branch: z.string(),
  target_branch: z.string(),
  /** Null until GitLab has worked out the MR's first diff. */
  diff_refs: z.object({ base_sha: z.string(), start_sha: z.string(), head_sha: z.string() }).nullable(),
});

/** `sha` is the source branch's head, which GitLab has before it has worked out the diff at it. */
const MergeRequestHeadResponse = z.object({
  state: z.enum(["opened", "closed", "locked", "merged"]),
  sha: z.string().nullable(),
  diff_refs: z.object({ head_sha: z.string() }).nullable(),
});

const DiffEntry = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  /** Empty when GitLab withheld it as too large or collapsed, and for a change with no lines. */
  diff: z.string(),
});

const CommitsResponse = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    message: z.string(),
    author_name: z.string(),
    authored_date: z.string(),
  }),
);

/** An issue in an external tracker comes back with an ID and a title, and no IID. */
const ClosesIssuesResponse = z.array(
  z.object({
    iid: z.number().optional(),
    web_url: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullish(),
    state: z.string().optional(),
  }),
);

const UserResponse = z.object({ username: z.string(), name: z.string().nullish() });

const BranchMergeRequestsResponse = z.array(
  z.object({
    title: z.string(),
    web_url: z.string(),
    author: z.object({ username: z.string() }).nullable(),
    sha: z.string(),
  }),
);

/** One end of a `line_range`, as GitLab keeps it. */
const LineRangeEnd = z.object({
  line_code: z.string().nullish(),
  type: z.string().nullish(),
  old_line: z.number().nullish(),
  new_line: z.number().nullish(),
});

/**
 * A draft's or a note's position, with only the fields a draft note takes, so one read back can be
 * sent again as it is. An MR-level draft has none, or one whose fields are all null.
 */
const PositionResponse = z.object({
  base_sha: z.string().nullish(),
  start_sha: z.string().nullish(),
  head_sha: z.string().nullish(),
  position_type: z.string().nullish(),
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  old_line: z.number().nullish(),
  new_line: z.number().nullish(),
  line_range: z.object({ start: LineRangeEnd, end: LineRangeEnd }).nullish(),
});

type Position = z.output<typeof PositionResponse>;

const DraftNoteResponse = z.object({
  id: z.number(),
  note: z.string(),
  /** Set on a reply to a published thread, whose place is the thread's rather than the draft's own. */
  discussion_id: z.string().nullish(),
  position: PositionResponse.nullish(),
});

const DiscussionResponse = z.object({
  id: z.string(),
  notes: z.array(z.object({ position: PositionResponse.nullish() })),
});

export type GitLabForgeOptions = {
  run: CommandRunner;
  /** The `glab` executable from the settings. */
  glab: () => Promise<string>;
};

/**
 * The GitLab adapter, over `glab api`. It addresses a project by its numeric ID, looked up once per
 * path, because some GitLab versions turn down a URL-encoded path on the draft notes endpoints.
 *
 * `glab` is only ever pointed at a host it is logged in to: given any other, it sends whatever token
 * it has there. So every host is checked with `glab auth status` before its first call.
 */
export function createGitLabForge(options: GitLabForgeOptions): Forge {
  const glab = createCli({ run: options.run, binary: options.glab, name: "glab", env: GLAB_ENV, unsetEnv: GLAB_UNSET_ENV });
  const hosts = new Map<string, Promise<void>>();
  const projectIds = new Map<string, Promise<number>>();

  /** Resolves once `glab` is known to be logged in to `host`; a failed check is asked again next time. */
  const loggedIn = (host: string) => remember(hosts, host, () => checkLogin(glab, host));

  const api = async <Schema extends z.ZodType>(repository: RepositoryRef, schema: Schema, path: string) => {
    await loggedIn(repository.host);
    return glab.json(schema, ["api", "--hostname", repository.host, path]);
  };

  const projectId = (repository: RepositoryRef) =>
    remember(projectIds, `${repository.host}/${repository.project.toLowerCase()}`, async () => {
      const project = await api(repository, ProjectResponse, `projects/${encodeURIComponent(repository.project)}`);
      return project.id;
    });

  /** Every document a paginated list has, read one per line: `--paginate` alone prints each page as its own array. */
  const list = async <Schema extends z.ZodType>(repository: RepositoryRef, schema: Schema, path: string) => {
    await loggedIn(repository.host);
    return glab.ndjson(schema, ["api", "--hostname", repository.host, path, "--paginate", "--output", "ndjson"]);
  };

  /**
   * A write, its body as JSON on stdin with the content type said outright: without it GitLab reads
   * the body as a form and drops a draft's position, and bracketed form fields drop it as well.
   */
  const send = async <Schema extends z.ZodType>(
    repository: RepositoryRef,
    schema: Schema,
    method: "POST" | "PUT",
    path: string,
    body: Record<string, unknown>,
  ) => {
    await loggedIn(repository.host);
    return glab.json(
      schema,
      ["api", "--hostname", repository.host, "--method", method, "--header", "Content-Type: application/json", "--input", "-", path],
      { input: JSON.stringify(body) },
    );
  };

  const draftNotes = async (ref: ChangeRequestRef) => `projects/${await projectId(ref)}/merge_requests/${ref.number}/draft_notes`;

  const deleteDraftNote = async (ref: ChangeRequestRef, id: string) => {
    await loggedIn(ref.host);
    // GitLab answers 204 with no body.
    await glab.text(["api", "--hostname", ref.host, "--method", "DELETE", `${await draftNotes(ref)}/${id}`]);
  };

  return {
    kind: "gitlab",
    urlHint: "a GitLab merge request URL on a host glab is logged in to, like https://gitlab.com/group/project/-/merge_requests/123",

    async matchUrl(url) {
      const ref = parseMergeRequestUrl(url);
      if (ref !== null) await loggedIn(ref.host);
      return ref;
    },

    async findByBranch(remote, branch): Promise<BranchChangeRequest[] | null> {
      // Any host but GitHub's may be a GitLab, as with a URL; one glab is not logged in to fails the check.
      const host = remote.host.toLowerCase();
      if (host.replace(/^www\./, "") === GITHUB_HOST) return null;
      const repository = { host, project: remote.project };
      const query = new URLSearchParams({ source_branch: branch, state: "opened", per_page: String(MAX_BRANCH_MERGE_REQUESTS) });
      const mergeRequests = await api(
        repository,
        BranchMergeRequestsResponse,
        `projects/${await projectId(repository)}/merge_requests?${query}`,
      );
      return mergeRequests.flatMap((mr) => {
        const ref = parseMergeRequestUrl(mr.web_url);
        return ref === null ? [] : [{ ref, title: mr.title, author: mr.author?.username ?? GHOST.login, headSha: mr.sha }];
      });
    },

    async fetchChangeRequest(ref) {
      const path = `projects/${await projectId(ref)}/merge_requests/${ref.number}`;
      const mr = await api(ref, MergeRequestResponse, path);
      if (mr.diff_refs === null) throw new ForgeError(`GitLab has not worked out the diff of ${ref.url} yet. Try again in a moment.`);

      // `--paginate` prints each page as its own array, one after the other; one document per line
      // is the output that reads back whole.
      const diffs = await glab.ndjson(DiffEntry, [
        "api",
        "--hostname",
        ref.host,
        `${path}/diffs?per_page=100`,
        "--paginate",
        "--output",
        "ndjson",
      ]);
      const commits = await api(ref, CommitsResponse, `${path}/commits?per_page=${MAX_COMMITS}`);
      const issues = await api(ref, ClosesIssuesResponse, `${path}/closes_issues?per_page=${MAX_LINKED_ISSUES}`);

      const files = diffs.map(changedFile);
      return {
        ref,
        title: mr.title,
        description: mr.description ?? "",
        author: mr.author ? { login: mr.author.username, name: mr.author.name ?? null } : GHOST,
        state: STATES[mr.state],
        isDraft: mr.draft ?? mr.work_in_progress ?? false,
        baseBranch: mr.target_branch,
        headBranch: mr.source_branch,
        baseSha: mr.diff_refs.base_sha,
        startSha: mr.diff_refs.start_sha,
        headSha: mr.diff_refs.head_sha,
        // GitLab's REST API has no line counts, so they are the diffs' own, which a withheld diff adds nothing to.
        additions: sum(files, "additions"),
        deletions: sum(files, "deletions"),
        // Newest first from GitLab; oldest first, as on GitHub, is the order they were written in.
        commits: [...commits].reverse().map((commit) => ({
          sha: commit.id,
          headline: commit.title,
          body: commit.message.replace(/\r\n/g, "\n").split("\n").slice(1).join("\n").trim(),
          author: commit.author_name,
          authoredAt: commit.authored_date,
        })),
        linkedIssues: issues.flatMap((issue) =>
          issue.iid === undefined || issue.web_url === undefined
            ? []
            : [{ number: issue.iid, url: issue.web_url, title: issue.title ?? "", body: issue.description ?? "", state: issue.state ?? "" }],
        ),
        files,
      } satisfies ChangeRequest;
    },

    async fetchHead(ref): Promise<ChangeRequestHead> {
      const mr = await api(ref, MergeRequestHeadResponse, `projects/${await projectId(ref)}/merge_requests/${ref.number}`);
      // The diff's head, which is what `fetchChangeRequest` reads, so a push shows once a new read would see it.
      const headSha = mr.diff_refs?.head_sha ?? mr.sha;
      if (headSha === null) throw new ForgeError(`GitLab has not worked out the diff of ${ref.url} yet. Try again in a moment.`);
      return { headSha, state: STATES[mr.state] };
    },

    async currentUser(ref): Promise<ForgeUser> {
      const user = await api(ref, UserResponse, "user");
      return { login: user.username, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      await loggedIn(ref.host);
      // glab picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await glab.text(["repo", "clone", `https://${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },

    /**
     * The viewer's draft notes, which GitLab keeps to their author. A reply to a published thread
     * sits where the thread does, so the MR's discussions are read when there is one. A draft on the
     * MR as a whole has no place in the diff and is left out.
     */
    async listDrafts(ref) {
      const notes = await list(ref, DraftNoteResponse, `${await draftNotes(ref)}?per_page=100`);
      const replies = notes.filter((note) => locationOf(note.position) === null && note.discussion_id);
      const threads = new Map<string, Position | null | undefined>();
      if (replies.length > 0) {
        const path = `projects/${await projectId(ref)}/merge_requests/${ref.number}/discussions?per_page=100`;
        for (const discussion of await list(ref, DiscussionResponse, path)) threads.set(discussion.id, discussion.notes[0]?.position);
      }
      return notes.flatMap((note) => {
        const location = locationOf(note.position) ?? (note.discussion_id ? locationOf(threads.get(note.discussion_id)) : null);
        return location === null ? [] : [{ id: String(note.id), body: note.note, location }];
      });
    },

    /**
     * A draft note at the anchor's position. GitLab can take a position and keep another, or none,
     * without an error, so the one it answers with is checked against the one sent, and a draft
     * that did not land where it was put is deleted again rather than left in the wrong place.
     */
    async createDraft(target, { anchor, body }): Promise<Draft> {
      const { ref } = target;
      const position = positionOf(target, anchor);
      const created = await send(ref, DraftNoteResponse, "POST", await draftNotes(ref), { note: body, position });
      const location = samePosition(position, created.position) ? locationOf(created.position) : null;
      if (location !== null) return { id: String(created.id), body: created.note, location };

      try {
        await deleteDraftNote(ref, String(created.id));
      } catch (error) {
        throw new ForgeError(
          `GitLab did not keep the comment where it was put, and deleting the misplaced draft failed too (${(error as Error).message}). Delete it on the merge request's page before submitting.`,
        );
      }
      throw new ForgeError("GitLab did not keep the comment where it was put, so the draft was deleted again. This GitLab may not take comments of this kind.");
    },

    /**
     * An edit sets the position to whatever it is sent, none included, so the draft's own is read
     * first and sent back with the new text.
     */
    async updateDraft(ref, draftId, body) {
      const id = draftNoteId(draftId);
      const path = `${await draftNotes(ref)}/${id}`;
      const current = await api(ref, DraftNoteResponse, path);
      const position = locationOf(current.position) === null ? {} : { position: current.position };
      await send(ref, DraftNoteResponse, "PUT", path, { note: body, ...position });
    },

    async deleteDraft(ref, draftId) {
      await deleteDraftNote(ref, draftNoteId(draftId));
    },
  };
}

/** A draft's ID as it goes in a path: GitLab's are numbers, and anything else would name another endpoint. */
function draftNoteId(draftId: string): string {
  if (!/^[1-9]\d{0,18}$/.test(draftId)) throw new ForgeError(`${draftId} is not a GitLab draft note.`);
  return draftId;
}

/**
 * Where a draft note goes, from the MR's diff refs: a line as a `text` position with `new_line` for
 * an added line, `old_line` for a removed one and both for an unchanged one; a range as its last
 * line plus a `line_range` whose ends carry their `line_code`s; a file as a `file` position.
 */
function positionOf(target: DraftTarget, anchor: DraftAnchor): Record<string, unknown> {
  const base = {
    base_sha: target.baseSha,
    start_sha: target.startSha,
    head_sha: target.headSha,
    old_path: anchor.previousPath ?? anchor.path,
    new_path: anchor.path,
  };
  switch (anchor.kind) {
    case "file":
      return { position_type: "file", ...base };
    case "line":
      return { position_type: "text", ...base, ...lineNumbers(anchor.line) };
    case "range":
      return {
        position_type: "text",
        ...base,
        ...lineNumbers(anchor.end),
        line_range: { start: rangeEnd(anchor.path, anchor.start), end: rangeEnd(anchor.path, anchor.end) },
      };
  }
}

function lineNumbers(line: AnchorLine): { old_line?: number; new_line?: number } {
  switch (line.kind) {
    case "added":
      return { new_line: line.newLine! };
    case "removed":
      return { old_line: line.oldLine! };
    case "context":
      return { old_line: line.oldLine!, new_line: line.newLine! };
  }
}

/**
 * One end of a range. Its `line_code` is the path's SHA-1 and GitLab's running counters at the line,
 * `path` being the file's new path, or its old one for a deleted file, as the anchor's path is.
 */
function rangeEnd(path: string, line: AnchorLine) {
  return {
    line_code: lineCode(path, line),
    type: line.kind === "added" ? "new" : line.kind === "removed" ? "old" : null,
    old_line: line.oldLine,
    new_line: line.newLine,
  };
}

function lineCode(path: string, line: Pick<AnchorLine, "oldPos" | "newPos">): string {
  return `${createHash("sha1").update(path).digest("hex")}_${line.oldPos}_${line.newPos}`;
}

const COMPARED = ["position_type", "base_sha", "start_sha", "head_sha", "old_path", "new_path", "old_line", "new_line"] as const;

/** Whether GitLab kept the position it was sent: the same place, and a range's ends by their line codes. */
function samePosition(sent: Record<string, unknown>, kept: Position | null | undefined): boolean {
  if (!kept) return false;
  if (!COMPARED.every((key) => (sent[key] ?? null) === (kept[key] ?? null))) return false;
  const range = sent.line_range as { start: { line_code: string }; end: { line_code: string } } | undefined;
  if (range === undefined) return true;
  return kept.line_range?.start.line_code === range.start.line_code && kept.line_range?.end.line_code === range.end.line_code;
}

/**
 * A position as a `DraftLocation`, or null for one on no file: an MR-level draft, whose position is
 * missing or all null. The last line is the top-level one; a range's first is its `line_range` start.
 */
function locationOf(position: Position | null | undefined): DraftLocation | null {
  const path = position?.new_path ?? position?.old_path;
  if (!position || !path) return null;
  const end = lineRef(position.new_line, position.old_line);
  if (position.position_type !== "text" || end === null) return { kind: "file", path };
  const start = position.line_range ? rangeEndRef(position.line_range.start) : null;
  if (start === null || (start.side === end.side && start.line === end.line)) return { kind: "line", path, line: end };
  return { kind: "range", path, start, end };
}

/** An unchanged line is named by its new number, as `lineRefOf` names it. */
function lineRef(newLine: number | null | undefined, oldLine: number | null | undefined): LineRef | null {
  if (newLine != null) return { side: "new", line: newLine };
  if (oldLine != null) return { side: "old", line: oldLine };
  return null;
}

/** A range end by its numbers, or by its `line_code`'s counters, which equal them on the side it is on. */
function rangeEndRef(end: z.output<typeof LineRangeEnd>): LineRef | null {
  const counters = /_(\d+)_(\d+)$/.exec(end.line_code ?? "");
  const oldLine = end.old_line ?? (counters ? Number(counters[1]) : null);
  const newLine = end.new_line ?? (counters ? Number(counters[2]) : null);
  if (end.type === "old") return lineRef(null, oldLine);
  return lineRef(newLine, oldLine);
}

async function checkLogin(glab: Cli, host: string): Promise<void> {
  if (await glab.succeeds(["auth", "status", "--hostname", host])) return;
  throw new ForgeError(`glab is not logged in to ${host}. Run \`glab auth login --hostname ${host}\` on the daemon's host.`);
}

/** The promise `create` makes for `key`, made once while it holds and again after it fails. */
function remember<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const created = create();
  cache.set(key, created);
  created.catch(() => {
    if (cache.get(key) === created) cache.delete(key);
  });
  return created;
}

function changedFile(entry: z.output<typeof DiffEntry>): ChangedFile {
  // GitLab's diff starts at the first `@@` like GitHub's patch, but ends in a newline GitHub's does not.
  const patch = entry.diff.startsWith("@@") ? entry.diff.replace(/\n$/, "") : null;
  let additions = 0;
  let deletions = 0;
  // Without the file header, every line starting with `+` or `-` is a changed line.
  for (const line of patch?.split("\n") ?? []) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return {
    path: entry.deleted_file ? entry.old_path : entry.new_path,
    previousPath: entry.renamed_file ? entry.old_path : null,
    status: entry.new_file ? "added" : entry.deleted_file ? "removed" : entry.renamed_file ? "renamed" : "modified",
    additions,
    deletions,
    patch,
  };
}

function sum(files: readonly ChangedFile[], field: "additions" | "deletions"): number {
  return files.reduce((total, file) => total + file[field], 0);
}

/** `locked` is an MR in the middle of being merged, which has not happened yet. */
const STATES: Record<"opened" | "closed" | "locked" | "merged", ChangeRequestState> = {
  opened: "open",
  closed: "closed",
  locked: "open",
  merged: "merged",
};

/** What an MR whose author's account was deleted is shown as. */
const GHOST: ForgeUser = { login: "ghost", name: null };

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * A merge request URL on any host but github.com, with or without its scheme and with whatever tab
 * or anchor it was copied from; anything else is null. The project path is everything before the
 * `/-/`, subgroups included. Whether `glab` can reach the host is a separate question.
 */
export function parseMergeRequestUrl(text: string): ChangeRequestRef | null {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // `glab --hostname` takes a host without its port; one on a port is set up in glab's own config.
  const host = url.hostname.toLowerCase();
  if (host === "" || host.replace(/^www\./, "") === GITHUB_HOST) return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const dash = segments.indexOf("-");
  if (dash < 2 || segments[dash + 1] !== "merge_requests") return null;
  const number = segments[dash + 2];
  if (number === undefined || !/^[1-9]\d{0,9}$/.test(number)) return null;
  const path = segments.slice(0, dash);
  if (!path.every((segment) => SEGMENT.test(segment))) return null;

  const project = path.join("/");
  return {
    forge: "gitlab",
    host,
    project,
    number: Number(number),
    url: `${url.protocol}//${url.host.toLowerCase()}/${project}/-/merge_requests/${number}`,
  };
}
