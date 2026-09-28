import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parsePullRequestUrl } from "./forge/github.ts";
import { ForgeError, type ChangeRequest, type ChangeRequestRef, type Forge, type ForgeUser } from "./forge/port.ts";

/**
 * A GitHub-shaped forge that answers from what the test put in it and records what it was asked.
 * URLs are matched the real adapter's way, so a test pastes the URLs a reviewer would.
 */
export type FakeForge = Forge & {
  /** Change requests by URL; a URL with none reads as a forge error. */
  changeRequests: Map<string, ChangeRequest>;
  viewer: ForgeUser;
  /** Every repository cloned, and where. */
  clones: { project: string; directory: string }[];
  /** When set, the next fetch fails with it. */
  failFetch: Error | null;
};

export function fakeForge(): FakeForge {
  const forge: FakeForge = {
    kind: "github",
    urlHint: "a GitHub pull request URL",
    changeRequests: new Map(),
    viewer: { login: "reviewer", name: "Rita Reviewer" },
    clones: [],
    failFetch: null,
    async matchUrl(url) {
      return parsePullRequestUrl(url);
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
    async currentUser() {
      return forge.viewer;
    },
    async cloneRepository(ref, directory) {
      forge.clones.push({ project: ref.project, directory });
      await mkdir(path.join(directory, ".git"), { recursive: true });
    },
  };
  return forge;
}

/** A plausible open PR, for a test to change only what it is about. */
export function sampleChangeRequest(url: string, overrides: Partial<Omit<ChangeRequest, "ref">> = {}): ChangeRequest {
  const ref = parsePullRequestUrl(url);
  if (ref === null) throw new Error(`Not a pull request URL: ${url}`);
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
    headSha: "b".repeat(40),
    additions: 42,
    deletions: 7,
    commits: [
      { sha: "c".repeat(40), headline: "Retry uploads", body: "", author: "author", authoredAt: "2026-09-01T10:00:00Z" },
    ],
    linkedIssues: [{ number: 12, url: `https://github.com/${ref.project}/issues/12`, title: "Uploads fail", body: "", state: "OPEN" }],
    files: [
      { path: "src/upload.ts", previousPath: null, status: "modified", additions: 30, deletions: 7, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
      { path: "src/retry.ts", previousPath: null, status: "added", additions: 12, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+c" },
    ],
    ...overrides,
  };
}
