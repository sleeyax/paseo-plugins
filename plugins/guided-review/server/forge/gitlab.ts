import { z } from "zod";
import type { CommandRunner } from "../command-runner.ts";
import { createCli, type Cli } from "./cli.ts";
import { GITHUB_HOST } from "./github.ts";
import {
  ForgeError,
  type BranchChangeRequest,
  type ChangedFile,
  type ChangeRequest,
  type ChangeRequestRef,
  type ChangeRequestState,
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

export type GitLabForgeOptions = {
  run: CommandRunner;
  /** The `glab` executable from the settings. */
  glab: () => Promise<string>;
};

/**
 * The GitLab adapter, over `glab api`. It addresses a project by its numeric ID, looked up once per
 * path, because some GitLab versions turn down a URL-encoded path on the endpoints later tickets use.
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

    async currentUser(ref): Promise<ForgeUser> {
      const user = await api(ref, UserResponse, "user");
      return { login: user.username, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      await loggedIn(ref.host);
      // glab picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await glab.text(["repo", "clone", `https://${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },
  };
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
