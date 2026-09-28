import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { BranchStart } from "../shared/contracts.ts";
import { fakeForge, openOnBranch, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply, sampleLayeredGuide, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces, type FakeCheckout, type FakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";
import type { FastForwardResult } from "./workspaces/port.ts";

/** "Guide this branch's PR/MR": the reviewer's own workspace on a PR's source branch. */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";
const LOCAL = "wks_local0000000000";
const LOCAL_DIRECTORY = "/home/r/src/uploader";
const BRANCH = "retry-uploads";
const HEAD = "b".repeat(40);

type Host = {
  forge: FakeForge;
  gitlab: FakeForge;
  workspaces: FakeWorkspaces;
  guideAgents: FakeGuideAgents;
  service: ReviewService;
  /** Opens the reviewer's workspace on `retry-uploads` of acme/uploader, fast-forwarding to `outcome`. */
  openLocal(outcome: FastForwardResult, overrides?: Partial<FakeCheckout>): void;
};

async function withHost(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  openOnBranch(forge, sampleChangeRequest(URL, { headBranch: BRANCH }));
  const gitlab = fakeForge("gitlab");
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", LOCAL_DIRECTORY);
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [forge, gitlab], workspaces, guideAgents, dataDirectory: data });
  const openLocal = (outcome: FastForwardResult, overrides: Partial<FakeCheckout> = {}) =>
    workspaces.openCheckout(LOCAL, {
      directory: LOCAL_DIRECTORY,
      branch: BRANCH,
      repository: { host: "github.com", project: "acme/uploader" },
      outcome,
      ...overrides,
    });
  return { forge, gitlab, workspaces, guideAgents, service, openLocal };
}

/** Starts guiding the workspace's branch and waits for everything it set off. */
async function guideBranch(service: ReviewService, url: string | null = null): Promise<BranchStart> {
  await service.startBranch({ workspaceId: LOCAL, url });
  await service.settled();
  const panel = await service.panel({ workspaceId: LOCAL });
  return panel.status === "none" && panel.branch ? panel.branch : { status: "finding" };
}

for (const outcome of [{ status: "fast-forwarded", from: "a".repeat(40) }, { status: "current" }] as const) {
  test(`a clean branch that is ${outcome.status} gets the guide in its own workspace`, async (t) => {
    const { service, workspaces, guideAgents, openLocal } = await withHost(t);
    openLocal(outcome);

    assert.deepEqual(await service.startBranch({ workspaceId: LOCAL, url: null }), { status: "finding" });
    await service.settled();

    assert.deepEqual(workspaces.fastForwards, [
      {
        workspaceId: LOCAL,
        branch: BRANCH,
        ref: { forge: "github", host: "github.com", project: "acme/uploader", number: 7, url: URL },
        headSha: HEAD,
      },
    ]);
    assert.deepEqual(workspaces.created, [], "no PR workspace");
    const panel = await service.panel({ workspaceId: LOCAL });
    assert.equal(panel.status, "ready");
    assert.deepEqual(panel.status === "ready" && { reviewId: panel.reviewId, guide: panel.guide, note: panel.note }, {
      reviewId: REVIEW_ID,
      guide: { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() },
      note: undefined,
    });
    assert.deepEqual(guideAgents.created[0]?.workspace, { id: LOCAL, directory: LOCAL_DIRECTORY, branch: BRANCH });
  });
}

const LEFT_ALONE: [FastForwardResult, string][] = [
  [{ status: "dirty" }, "retry-uploads has uncommitted changes"],
  [{ status: "diverged" }, "retry-uploads has commits that are not in #7"],
  [{ status: "moved", branch: "main" }, "The workspace is no longer on retry-uploads"],
  [{ status: "failed", message: "Could not fetch refs/pull/7/head: couldn't find remote ref" }, "retry-uploads could not be fast-forwarded to #7 (Could not fetch refs/pull/7/head: couldn't find remote ref)"],
];

for (const [outcome, reason] of LEFT_ALONE) {
  test(`a ${outcome.status} branch is left untouched, says why, and the guide goes to a PR workspace`, async (t) => {
    const { service, workspaces, guideAgents, openLocal } = await withHost(t);
    openLocal(outcome);
    const note = `${reason}, so it was left untouched and the guide is in a PR workspace instead.`;

    const branch = await guideBranch(service);

    assert.equal(workspaces.fastForwards.length, 1);
    assert.deepEqual(
      workspaces.created.map(({ id, repositoryRoot }) => ({ id, repositoryRoot })),
      [{ id: "wks_0000000000000001", repositoryRoot: LOCAL_DIRECTORY }],
    );
    assert.deepEqual(branch, {
      status: "started",
      reviewId: REVIEW_ID,
      progress: { phase: "ready", header: branch.status === "started" ? branch.progress.header : null, workspaceId: "wks_0000000000000001", message: null },
      note,
    });
    const panel = await service.panel({ workspaceId: "wks_0000000000000001" });
    assert.equal(panel.status === "ready" && panel.note, note);
    assert.deepEqual(guideAgents.created[0]?.workspace, { id: "wks_0000000000000001", directory: `${LOCAL_DIRECTORY}-worktrees/pr-7` });
  });
}

test("a branch no open PR comes from says so, and nothing is started", async (t) => {
  const { service, workspaces, openLocal } = await withHost(t);
  openLocal({ status: "current" }, { branch: "main" });

  assert.deepEqual(await guideBranch(service), { status: "none", message: "No open pull request in acme/uploader comes from main." });
  assert.deepEqual(workspaces.fastForwards, []);
  assert.deepEqual(workspaces.created, []);
});

test("a branch on GitLab is looked up there, and says merge request when it has none", async (t) => {
  const { service, gitlab, openLocal } = await withHost(t);
  openLocal({ status: "current" }, { repository: { host: "gitlab.example.com", project: "acme/uploader" } });

  assert.deepEqual(await guideBranch(service), { status: "none", message: "No open merge request in acme/uploader comes from retry-uploads." });

  const mrUrl = "https://gitlab.example.com/acme/uploader/-/merge_requests/7";
  openOnBranch(gitlab, sampleChangeRequest(mrUrl, { headBranch: BRANCH }));
  await guideBranch(service);
  const panel = await service.panel({ workspaceId: LOCAL });
  assert.equal(panel.status === "ready" && panel.header.url, mrUrl);
});

test("several open PRs from the branch are offered as a choice, and the chosen one is guided here", async (t) => {
  const { service, forge, workspaces, openLocal } = await withHost(t);
  openLocal({ status: "fast-forwarded", from: "a".repeat(40) });
  const forkUrl = "https://github.com/acme/uploader/pull/9";
  openOnBranch(forge, sampleChangeRequest(forkUrl, { headBranch: BRANCH, title: "Retry uploads, from a fork", author: { login: "forker", name: null } }));

  assert.deepEqual(await guideBranch(service), {
    status: "choose",
    branch: BRANCH,
    candidates: [
      { forge: "github", url: URL, number: 7, title: "Retry failed uploads", author: "author" },
      { forge: "github", url: forkUrl, number: 9, title: "Retry uploads, from a fork", author: "forker" },
    ],
  });
  assert.equal(workspaces.fastForwards.length, 0, "nothing is touched before the choice");

  await service.startBranch({ workspaceId: LOCAL, url: forkUrl });
  await service.settled();

  assert.deepEqual(
    workspaces.fastForwards.map((entry) => entry.ref.number),
    [9],
  );
  const panel = await service.panel({ workspaceId: LOCAL });
  assert.equal(panel.status === "ready" && panel.header.number, 9);
});

test("a workspace that is detached, has no forge origin, or is gone says why there is nothing to guide", async (t) => {
  const { service, workspaces, openLocal } = await withHost(t);

  openLocal({ status: "current" }, { branch: null });
  assert.deepEqual(await guideBranch(service), { status: "none", message: "This workspace is not on a branch, so no PR or MR comes from it." });

  openLocal({ status: "current" }, { repository: null });
  assert.deepEqual(await guideBranch(service), {
    status: "none",
    message: "This workspace's repository has no origin on GitHub or GitLab to find a PR or MR on.",
  });

  workspaces.archive(LOCAL);
  assert.deepEqual(await guideBranch(service), { status: "failed", message: "This workspace is not open any more." });
});

test("a forge that cannot be asked about the branch fails in its words", async (t) => {
  const { service, forge, openLocal } = await withHost(t);
  openLocal({ status: "current" });
  forge.failFindByBranch = new ForgeError("gh failed: HTTP 401: Bad credentials");

  assert.deepEqual(await guideBranch(service), { status: "failed", message: "gh failed: HTTP 401: Bad credentials" });
});

test("a review attached to the reviewer's branch is fast-forwarded again when it is started from its URL", async (t) => {
  const { service, forge, workspaces, openLocal } = await withHost(t);
  openLocal({ status: "current" });
  await guideBranch(service);

  forge.changeRequests.set(URL, sampleChangeRequest(URL, { headBranch: BRANCH, title: "Retry uploads with backoff" }));
  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(
    workspaces.fastForwards.map((entry) => entry.workspaceId),
    [LOCAL, LOCAL],
  );
  assert.deepEqual(workspaces.created, []);
  const panel = await service.panel({ workspaceId: LOCAL });
  assert.equal(panel.status === "ready" && panel.header.title, "Retry uploads with backoff");
});

test("after a push, guiding the branch again leaves it and its guide where they are, for Regenerate to move", async (t) => {
  const { service, forge, workspaces, guideAgents, openLocal } = await withHost(t);
  openLocal({ status: "current" });
  await guideBranch(service);

  forge.changeRequests.set(URL, sampleChangeRequest(URL, { headBranch: BRANCH, headSha: "d".repeat(40) }));
  openLocal({ status: "fast-forwarded", from: HEAD });
  await service.startBranch({ workspaceId: LOCAL, url: null });
  await service.settled();

  assert.deepEqual(workspaces.fastForwards.map((entry) => entry.headSha), [HEAD]);
  assert.equal(guideAgents.created.length, 1);
  const panel = await service.panel({ workspaceId: LOCAL });
  assert.equal(panel.status === "ready" && panel.header.headSha, HEAD);
  assert.deepEqual(await service.checkHead({ reviewId: REVIEW_ID }), {
    guideHeadSha: HEAD,
    forgeHeadSha: "d".repeat(40),
    moved: true,
    state: "open",
    message: null,
  });
});

test("once the attached branch has local work, a new start moves the guide to a PR workspace and says why", async (t) => {
  const { service, workspaces, guideAgents, openLocal } = await withHost(t);
  openLocal({ status: "current" });
  await guideBranch(service);

  openLocal({ status: "dirty" });
  await service.start({ url: URL });
  await service.settled();

  assert.equal(workspaces.created.length, 1);
  const moved = await service.panel({ workspaceId: "wks_0000000000000001" });
  assert.equal(moved.status === "ready" && moved.note, "retry-uploads has uncommitted changes, so it was left untouched and the guide is in a PR workspace instead.");
  assert.deepEqual(guideAgents.archived, ["agent-1"], "the guide in the reviewer's workspace ended with the move");
  assert.deepEqual(await service.panel({ workspaceId: LOCAL }), {
    status: "none",
    branch: {
      status: "started",
      reviewId: REVIEW_ID,
      progress: { phase: "ready", header: moved.status === "ready" ? moved.header : null, workspaceId: "wks_0000000000000001", message: null },
      note: "retry-uploads has uncommitted changes, so it was left untouched and the guide is in a PR workspace instead.",
    },
  });
});

test("a PR that does not come from the workspace's branch after all is never fast-forwarded onto it", async (t) => {
  const { service, forge, workspaces, openLocal } = await withHost(t);
  openLocal({ status: "fast-forwarded", from: "a".repeat(40) });
  // The PR was renamed between finding it and reading it.
  forge.changeRequests.set(URL, sampleChangeRequest(URL, { headBranch: "retry-uploads-v2" }));

  const branch = await guideBranch(service);

  assert.deepEqual(workspaces.fastForwards, []);
  assert.equal(
    branch.status === "started" && branch.note,
    "#7 comes from retry-uploads-v2, not retry-uploads, so it was left untouched and the guide is in a PR workspace instead.",
  );
});
