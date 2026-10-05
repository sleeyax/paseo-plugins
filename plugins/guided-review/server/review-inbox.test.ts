import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ReviewRequest, ReviewRequestHost } from "../shared/inbox.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

const GITHUB_URL = "https://github.com/acme/uploader/pull/7";
const GITLAB_URL = "https://gitlab.com/acme/uploader/-/merge_requests/7";
const HEAD = "b".repeat(40);
const PUSHED = "d".repeat(40);

type Host = { github: FakeForge; gitlab: FakeForge; service: ReviewService };

async function withForges(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-inbox-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const github = fakeForge("github");
  const gitlab = fakeForge("gitlab");
  github.changeRequests.set(GITHUB_URL, sampleChangeRequest(GITHUB_URL));
  gitlab.changeRequests.set(GITLAB_URL, sampleChangeRequest(GITLAB_URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  workspaces.repositories.set("gitlab.com/acme/uploader", "/home/r/src/uploader-gl");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [github, gitlab], workspaces, guideAgents, dataDirectory: data });
  return { github, gitlab, service };
}

async function startReview(service: ReviewService, url: string) {
  await service.start({ url });
  await service.settled();
}

function request(url: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  const gitlab = url.includes("/-/merge_requests/");
  return {
    forge: gitlab ? "gitlab" : "github",
    host: gitlab ? "gitlab.com" : "github.com",
    project: "acme/uploader",
    number: 7,
    url,
    title: "Retry failed uploads",
    author: "author",
    isDraft: false,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    headSha: HEAD,
    additions: 42,
    deletions: 7,
    fileCount: 2,
    ci: null,
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: gitlab ? null : 0,
    ...overrides,
  };
}

function listed(forge: "github" | "gitlab", requests: ReviewRequest[], extra: Partial<ReviewRequestHost> = {}): ReviewRequestHost {
  return { forge, host: forge === "github" ? "github.com" : "gitlab.com", requests, truncated: false, error: null, ...extra };
}

test("lists every forge's review requests with their hosts, and none started here has a local review", async (t) => {
  const { github, gitlab, service } = await withForges(t);
  github.reviewRequests = [listed("github", [request(GITHUB_URL)], { truncated: true })];
  gitlab.reviewRequests = [
    listed("gitlab", [request(GITLAB_URL)]),
    listed("gitlab", [], { host: "gitlab.example.com", error: "glab is not logged in to gitlab.example.com." }),
  ];

  const inbox = await service.inbox();

  assert.deepEqual(inbox.hosts, [
    { forge: "github", host: "github.com", truncated: true, error: null },
    { forge: "gitlab", host: "gitlab.com", truncated: false, error: null },
    { forge: "gitlab", host: "gitlab.example.com", truncated: false, error: "glab is not logged in to gitlab.example.com." },
  ]);
  assert.deepEqual(inbox.items, [
    { ...request(GITHUB_URL), local: null },
    { ...request(GITLAB_URL), local: null },
  ]);
});

test("a change request reviewed here carries its review, its guide's state and whether the forge's head moved past it", async (t) => {
  const { github, service } = await withForges(t);
  await startReview(service, GITHUB_URL);

  github.reviewRequests = [listed("github", [request(GITHUB_URL)])];
  assert.deepEqual((await service.inbox()).items[0]?.local, { reviewId: "github/github.com/acme/uploader/7", guide: "ready", headMoved: false });

  github.reviewRequests = [listed("github", [request(GITHUB_URL, { headSha: PUSHED })])];
  assert.equal((await service.inbox()).items[0]?.local?.headMoved, true);
});

test("on GitLab the drafts are counted for an MR reviewed here only, and a failed count reads as unknown", async (t) => {
  const { gitlab, service } = await withForges(t);
  await startReview(service, GITLAB_URL);
  const other = "https://gitlab.com/acme/uploader/-/merge_requests/8";
  gitlab.drafts.set(GITLAB_URL, [
    { id: "1", body: "Why the retry cap?", location: { kind: "general" } },
    { id: "2", body: "Typo", location: { kind: "file", path: "src/upload.ts" } },
  ]);
  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL), request(other, { number: 8 })])];

  const items = (await service.inbox()).items;
  assert.deepEqual(
    items.map((item) => item.pendingDrafts),
    [2, null],
  );

  gitlab.listDrafts = async () => {
    throw new ForgeError("glab failed: 500 Internal Server Error");
  };
  assert.equal((await service.inbox()).items[0]?.pendingDrafts, null);
});

test("a GitLab review published from here says whether the head moved since, over the listing's guess", async (t) => {
  const { gitlab, service } = await withForges(t);
  await startReview(service, GITLAB_URL);
  const reviewId = "gitlab/gitlab.com/acme/uploader/7";

  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL, { state: "commented", changedSinceReview: null })])];
  assert.equal((await service.inbox()).items[0]?.changedSinceReview, null, "nothing published from here yet");

  const submitted = await service.submit({ reviewId, headSha: HEAD, verdict: "comment", body: "Reads well." });
  assert.equal(submitted.status, "submitted");

  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL, { state: "commented", changedSinceReview: true })])];
  assert.equal((await service.inbox()).items[0]?.changedSinceReview, false, "the head is still the one reviewed");

  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL, { state: "commented", headSha: PUSHED, changedSinceReview: false })])];
  assert.equal((await service.inbox()).items[0]?.changedSinceReview, true, "pushed since");

  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL, { state: "requested", changedSinceReview: null })])];
  assert.equal((await service.inbox()).items[0]?.changedSinceReview, null, "asked again, which the listing says");
});
