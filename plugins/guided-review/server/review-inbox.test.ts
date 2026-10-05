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

type Host = { github: FakeForge; gitlab: FakeForge; service: ReviewService; restart: () => ReviewService };

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
  const restart = () => new ReviewService({ forges: [github, gitlab], workspaces, guideAgents, dataDirectory: data });
  return { github, gitlab, service: restart(), restart };
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
    { ...request(GITHUB_URL), local: null, checkedOff: false },
    { ...request(GITLAB_URL), local: null, checkedOff: false },
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

async function checkedOff(service: ReviewService): Promise<string[]> {
  return (await service.inbox()).items.filter((item) => item.checkedOff).map((item) => item.url);
}

test("a check-off holds while the change request stands still, survives a restart and is undone by unchecking", async (t) => {
  const { github, gitlab, service, restart } = await withForges(t);
  github.reviewRequests = [listed("github", [request(GITHUB_URL)])];
  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL)])];

  await service.setCheckedOff({ url: GITLAB_URL, checkOff: { headSha: HEAD, state: "requested" } });
  assert.deepEqual(await checkedOff(service), [GITLAB_URL]);
  assert.deepEqual(await checkedOff(restart()), [GITLAB_URL], "still requested, as when it was checked off");

  await service.setCheckedOff({ url: GITLAB_URL, checkOff: null });
  assert.deepEqual(await checkedOff(service), []);
});

test("a check-off comes back on a push, or when the reviewer is asked again or loses an approval", async (t) => {
  const { gitlab, service } = await withForges(t);
  const comeBack = async (checkOff: { headSha: string; state: ReviewRequest["state"] }, ...listings: Partial<ReviewRequest>[]) => {
    await service.setCheckedOff({ url: GITLAB_URL, checkOff });
    const seen: boolean[] = [];
    for (const listing of listings) {
      gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL, listing)])];
      seen.push((await checkedOff(service)).length === 1);
    }
    return seen;
  };

  assert.deepEqual(await comeBack({ headSha: HEAD, state: "commented" }, { state: "commented", headSha: PUSHED }, { state: "commented", headSha: HEAD }), [false, false]);
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "commented" }, { state: "requested" }), [false]);
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "approved" }, { state: "unapproved" }), [false]);
  assert.deepEqual(
    await comeBack({ headSha: HEAD, state: "requested" }, { state: "commented" }, { state: "changes-requested" }, { state: "requested" }),
    [true, true, false],
    "a state the reviewer moved to themselves holds, and being asked again after it brings it back",
  );
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "requested" }, { state: "requested", headSha: "" }), [true], "a head the forge did not say is no push");
});

test("a check-off goes once a host listed in full no longer has it, and stays while its host fails or has more", async (t) => {
  const { gitlab, service } = await withForges(t);
  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL)])];
  await service.setCheckedOff({ url: GITLAB_URL, checkOff: { headSha: HEAD, state: "requested" } });

  gitlab.reviewRequests = [listed("gitlab", [], { error: "glab is not logged in to gitlab.com." })];
  await service.inbox();
  gitlab.reviewRequests = [listed("gitlab", [], { truncated: true })];
  await service.inbox();
  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL)])];
  assert.deepEqual(await checkedOff(service), [GITLAB_URL]);

  gitlab.reviewRequests = [listed("gitlab", [])];
  await service.inbox();
  gitlab.reviewRequests = [listed("gitlab", [request(GITLAB_URL)])];
  assert.deepEqual(await checkedOff(service), []);
});
