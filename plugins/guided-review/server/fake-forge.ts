import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parsePullRequestUrl } from "./forge/github.ts";
import { parseMergeRequestUrl } from "./forge/gitlab.ts";
import { lineRefOf, type Draft, type DraftLocation } from "../shared/drafts.ts";
import {
  ForgeError,
  type BranchChangeRequest,
  type ChangeRequest,
  type ChangeRequestRef,
  type DraftAnchor,
  type DraftTarget,
  type Forge,
  type ForgeKind,
  type ForgeUser,
  type ReviewSubmission,
  type SubmitOutcome,
} from "./forge/port.ts";

/**
 * A forge that answers from what the test put in it and records what it was asked. URLs are matched
 * the real adapter's way, so a test pastes the URLs a reviewer would; it is GitHub unless told otherwise.
 */
export type FakeForge = Forge & {
  /** Change requests by URL; a URL with none reads as a forge error. */
  changeRequests: Map<string, ChangeRequest>;
  /** Open change requests by `host/project#branch`; a branch with none has none. See `openOnBranch`. */
  branches: Map<string, BranchChangeRequest[]>;
  /** When set, the next branch lookup fails with it. */
  failFindByBranch: Error | null;
  viewer: ForgeUser;
  /** Every repository cloned, and where. */
  clones: { project: string; directory: string }[];
  /** When set, the next fetch fails with it. */
  failFetch: Error | null;
  /** The reviewer's drafts by change request URL, as the forge lists them; a test adds ones "started on the web". */
  drafts: Map<string, Draft[]>;
  /** Every draft created, with what it was sent. */
  created: { target: DraftTarget; anchor: DraftAnchor; body: string }[];
  /** When set, the next head read fails with it. */
  failFetchHead: Error | null;
  /** How many times the head alone was read. */
  headReads: number;
  /** The review body the forge keeps, by change request URL, as GitHub keeps it on the pending review. */
  bodies: Map<string, string>;
  /** Every submit, with what it was sent. */
  submissions: { target: DraftTarget; submission: ReviewSubmission }[];
  /** When set, the next submit answers with it; otherwise a submit lands whole, in one step. */
  submitOutcome: SubmitOutcome | null;
  /** The URL of every change request whose pending review was discarded. */
  discarded: string[];
};

/** Where the forge says a draft on `anchor` is: a line by the side both forges put it on. */
export function locationOfAnchor(anchor: DraftAnchor): DraftLocation {
  switch (anchor.kind) {
    case "line":
      return { kind: "line", path: anchor.path, line: lineRefOf(anchor.line) };
    case "range":
      return { kind: "range", path: anchor.path, start: lineRefOf(anchor.start), end: lineRefOf(anchor.end) };
    case "file":
      return { kind: "file", path: anchor.path };
    case "general":
      return { kind: "general" };
  }
}

export function fakeForge(kind: ForgeKind = "github"): FakeForge {
  const forge: FakeForge = {
    kind,
    urlHint: kind === "github" ? "a GitHub pull request URL" : "a GitLab merge request URL",
    changeRequests: new Map(),
    branches: new Map(),
    failFindByBranch: null,
    viewer: { login: "reviewer", name: "Rita Reviewer" },
    clones: [],
    failFetch: null,
    drafts: new Map(),
    created: [],
    failFetchHead: null,
    headReads: 0,
    bodies: new Map(),
    submissions: [],
    submitOutcome: null,
    discarded: [],
    async matchUrl(url) {
      return PARSERS[kind](url);
    },
    async findByBranch(repository, branch) {
      // GitHub's adapter takes github.com only, and GitLab's every other host.
      if ((repository.host === "github.com") !== (kind === "github")) return null;
      if (forge.failFindByBranch) {
        const error = forge.failFindByBranch;
        forge.failFindByBranch = null;
        throw error;
      }
      return structuredClone(forge.branches.get(`${repository.host}/${repository.project}#${branch}`) ?? []);
    },
    async fetchChangeRequest(ref) {
      if (forge.failFetch) {
        const error = forge.failFetch;
        forge.failFetch = null;
        throw error;
      }
      const changeRequest = forge.changeRequests.get(ref.url);
      if (!changeRequest) throw new ForgeError(`gh failed: Could not resolve to a PullRequest with the number of ${ref.number}.`);
      return structuredClone(changeRequest);
    },
    async fetchHead(ref) {
      forge.headReads += 1;
      if (forge.failFetchHead) {
        const error = forge.failFetchHead;
        forge.failFetchHead = null;
        throw error;
      }
      const changeRequest = forge.changeRequests.get(ref.url);
      if (!changeRequest) throw new ForgeError(`gh failed: Could not resolve to a PullRequest with the number of ${ref.number}.`);
      return { headSha: changeRequest.headSha, state: changeRequest.state };
    },
    async currentUser() {
      return forge.viewer;
    },
    async cloneRepository(ref, directory) {
      forge.clones.push({ project: ref.project, directory });
      await mkdir(path.join(directory, ".git"), { recursive: true });
    },
    async listDrafts(ref) {
      return structuredClone(forge.drafts.get(ref.url) ?? []);
    },
    async createDraft(target, { anchor, body }) {
      // As the real adapter: GitHub's comment on the whole pull request is a paragraph of the review body.
      if (kind === "github" && anchor.kind === "general") throw new ForgeError("GitHub keeps a comment on the pull request as a whole in the review body.");
      forge.created.push(structuredClone({ target, anchor, body }));
      const draft: Draft = { id: `draft-${forge.created.length}`, body, location: locationOfAnchor(anchor) };
      forge.drafts.set(target.ref.url, [...(forge.drafts.get(target.ref.url) ?? []), draft]);
      return structuredClone(draft);
    },
    async updateDraft(ref, draftId, body) {
      const draft = forge.drafts.get(ref.url)?.find((candidate) => candidate.id === draftId);
      if (!draft) throw new ForgeError("gh failed: Could not resolve to a node with the global id.");
      draft.body = body;
    },
    async deleteDraft(ref, draftId) {
      const drafts = forge.drafts.get(ref.url) ?? [];
      if (!drafts.some((draft) => draft.id === draftId)) throw new ForgeError("gh failed: Could not resolve to a node with the global id.");
      forge.drafts.set(
        ref.url,
        drafts.filter((draft) => draft.id !== draftId),
      );
    },
    // GitHub keeps the body on the pending review; GitLab keeps none, so the service does.
    reviewBody:
      kind === "github"
        ? {
            async read(ref) {
              return forge.bodies.get(ref.url) ?? "";
            },
            async write(target, body) {
              forge.bodies.set(target.ref.url, body);
            },
          }
        : null,
    async submitReview(target, submission) {
      forge.submissions.push(structuredClone({ target, submission }));
      const outcome = forge.submitOutcome ?? {
        published: true,
        steps: [{ id: "submit", label: "Publish the review", status: "done" as const, message: null }],
      };
      forge.submitOutcome = null;
      if (outcome.published) {
        forge.drafts.delete(target.ref.url);
        forge.bodies.delete(target.ref.url);
      }
      return structuredClone(outcome);
    },
    async discardReview(ref) {
      forge.discarded.push(ref.url);
      forge.drafts.delete(ref.url);
      forge.bodies.delete(ref.url);
    },
  };
  return forge;
}

/** Makes `changeRequest` readable by its URL and findable by its source branch, beside any already there. */
export function openOnBranch(forge: FakeForge, changeRequest: ChangeRequest): void {
  const { ref } = changeRequest;
  forge.changeRequests.set(ref.url, changeRequest);
  const key = `${ref.host}/${ref.project}#${changeRequest.headBranch}`;
  const found: BranchChangeRequest = { ref, title: changeRequest.title, author: changeRequest.author.login, headSha: changeRequest.headSha };
  forge.branches.set(key, [...(forge.branches.get(key) ?? []), found]);
}

const PARSERS: Record<ForgeKind, (url: string) => ChangeRequestRef | null> = {
  github: parsePullRequestUrl,
  gitlab: parseMergeRequestUrl,
};

/** A plausible open PR, for a test to change only what it is about. */
export function sampleChangeRequest(url: string, overrides: Partial<Omit<ChangeRequest, "ref">> = {}): ChangeRequest {
  const ref = parsePullRequestUrl(url) ?? parseMergeRequestUrl(url);
  if (ref === null) throw new Error(`Not a pull request or merge request URL: ${url}`);
  return {
    ref: ref satisfies ChangeRequestRef,
    title: "Retry failed uploads",
    description: "Uploads that fail on a flaky network are retried with backoff.",
    author: { login: "author", name: "Arthur Author" },
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "retry-uploads",
    baseSha: "a".repeat(40),
    startSha: "a".repeat(40),
    headSha: "b".repeat(40),
    additions: 42,
    deletions: 7,
    commits: [
      { sha: "c".repeat(40), headline: "Retry uploads", body: "Full jitter, since a fixed delay would make clients retry in lockstep.", author: "author", authoredAt: "2026-09-01T10:00:00Z" },
    ],
    linkedIssues: [{ number: 12, url: `https://github.com/${ref.project}/issues/12`, title: "Uploads fail", body: "", state: "OPEN" }],
    files: [
      { path: "src/upload.ts", previousPath: null, status: "modified", additions: 30, deletions: 7, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
      { path: "src/retry.ts", previousPath: null, status: "added", additions: 12, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+c" },
    ],
    ...overrides,
  };
}
