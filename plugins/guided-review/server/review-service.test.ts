import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, sampleLayeredGuide, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces, type FakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

const URL = "https://github.com/acme/uploader/pull/7";

type Host = {
  data: string;
  forge: FakeForge;
  workspaces: FakeWorkspaces;
  guideAgents: FakeGuideAgents;
  service: ReviewService;
  /** A second service over the same data directory, as after a plugin restart. */
  restart(): ReviewService;
};

async function withHost(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, sampleChangeRequest(URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const create = () => new ReviewService({ forges: [forge], workspaces, guideAgents, dataDirectory: data });
  return { data, forge, workspaces, guideAgents, service: create(), restart: create };
}

/** Starts a review and waits for its background job, the way the start screen polls it. */
async function startAndSettle(service: ReviewService, url: string) {
  const started = await service.start({ url });
  await service.settled();
  assert.equal(started.status, "started");
  return service.startProgress({ reviewId: started.status === "started" ? started.reviewId : "" });
}

const HEADER = {
  forge: "github",
  url: URL,
  project: "acme/uploader",
  number: 7,
  title: "Retry failed uploads",
  author: "author",
  state: "open",
  isDraft: false,
  fileCount: 2,
  additions: 42,
  deletions: 7,
  headSha: "b".repeat(40),
};

test("starting from a PR URL creates a PR workspace on the local clone and shows the header in its panel", async (t) => {
  const { service, workspaces } = await withHost(t);

  const progress = await startAndSettle(service, `${URL}/files`);

  assert.deepEqual(progress, { phase: "ready", header: HEADER, workspaceId: "wks_0000000000000001", message: null });
  assert.deepEqual(workspaces.created, [
    {
      id: "wks_0000000000000001",
      repositoryRoot: "/home/r/src/uploader",
      ref: { forge: "github", host: "github.com", project: "acme/uploader", number: 7, url: URL },
      title: "Review #7: Retry failed uploads",
    },
  ]);
  assert.deepEqual(await service.panel({ workspaceId: "wks_0000000000000001" }), {
    status: "ready",
    reviewId: "github/github.com/acme/uploader/7",
    header: HEADER,
    guide: { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() },
  });
});

test("a URL that is not a pull request is turned down with a clear message and starts nothing", async (t) => {
  const { service, workspaces } = await withHost(t);

  for (const url of ["https://github.com/acme/uploader/issues/7", "https://gitlab.com/acme/uploader/-/merge_requests/7", "hello"]) {
    assert.deepEqual(await service.start({ url }), {
      status: "rejected",
      message: "That is not a GitHub pull request URL.",
    });
  }
  await service.settled();
  assert.deepEqual(workspaces.created, []);
});

test("a GitLab MR URL gets a PR workspace checked out from GitLab, beside GitHub", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const mrUrl = "https://gitlab.example.com/acme/platform/uploader/-/merge_requests/7";
  const gitlab = fakeForge("gitlab");
  gitlab.changeRequests.set(mrUrl, sampleChangeRequest(mrUrl));
  const workspaces = fakeWorkspaces();
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [fakeForge(), gitlab], workspaces, guideAgents, dataDirectory: data });
  const clone = path.join(data, "clones", "gitlab.example.com", "acme", "platform", "uploader");

  const progress = await startAndSettle(service, `${mrUrl}/diffs`);

  assert.equal(progress.phase, "ready");
  assert.deepEqual(progress.header, { ...HEADER, forge: "gitlab", url: mrUrl, project: "acme/platform/uploader" });
  assert.deepEqual(gitlab.clones, [{ project: "acme/platform/uploader", directory: clone }]);
  assert.deepEqual(workspaces.created, [
    {
      id: "wks_0000000000000001",
      repositoryRoot: clone,
      ref: { forge: "gitlab", host: "gitlab.example.com", project: "acme/platform/uploader", number: 7, url: mrUrl },
      title: "Review !7: Retry failed uploads",
    },
  ]);
});

test("a URL a forge claims but cannot read is turned down in the forge's words", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-data-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const gitlab = fakeForge("gitlab");
  gitlab.matchUrl = async () => {
    throw new ForgeError("glab is not logged in to gitlab.example.com.");
  };
  const workspaces = fakeWorkspaces();
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [fakeForge(), gitlab], workspaces, guideAgents, dataDirectory: data });

  assert.deepEqual(await service.start({ url: "https://gitlab.example.com/acme/app/-/merge_requests/7" }), {
    status: "rejected",
    message: "glab is not logged in to gitlab.example.com.",
  });
  await service.settled();
  assert.deepEqual(workspaces.created, []);
});

test("a repository no Paseo project has is cloned into the data directory once, and the workspace cut from it", async (t) => {
  const { service, forge, workspaces, data } = await withHost(t);
  workspaces.repositories.clear();
  const clone = path.join(data, "clones", "github.com", "acme", "uploader");

  await startAndSettle(service, URL);
  workspaces.archive("wks_0000000000000001");
  await startAndSettle(service, URL);

  assert.deepEqual(forge.clones, [{ project: "acme/uploader", directory: clone }]);
  assert.deepEqual(
    workspaces.created.map((created) => created.repositoryRoot),
    [clone, clone],
  );
});

test("two PRs of a repository no Paseo project has, started together, clone it once and both cut their workspace from it", async (t) => {
  const { service, forge, workspaces, data } = await withHost(t);
  workspaces.repositories.clear();
  const other = "https://github.com/acme/uploader/pull/8";
  forge.changeRequests.set(other, sampleChangeRequest(other));
  const clone = path.join(data, "clones", "github.com", "acme", "uploader");

  await Promise.all([service.start({ url: URL }), service.start({ url: other })]);
  await service.settled();

  assert.deepEqual(forge.clones, [{ project: "acme/uploader", directory: clone }]);
  assert.deepEqual(
    workspaces.created.map((created) => created.repositoryRoot),
    [clone, clone],
  );
});

test("a clone that never finished is replaced rather than used", async (t) => {
  const { service, forge, workspaces, data } = await withHost(t);
  workspaces.repositories.clear();
  const clone = path.join(data, "clones", "github.com", "acme", "uploader");
  await mkdir(clone, { recursive: true });

  const progress = await startAndSettle(service, URL);

  assert.equal(progress.phase, "ready");
  assert.deepEqual(forge.clones, [{ project: "acme/uploader", directory: clone }]);
});

test("starting the same PR again reuses its open workspace, and a new one once that is archived", async (t) => {
  const { service, workspaces } = await withHost(t);

  await startAndSettle(service, URL);
  const again = await startAndSettle(service, URL);
  assert.equal(again.workspaceId, "wks_0000000000000001");
  assert.equal(workspaces.created.length, 1);

  workspaces.archive("wks_0000000000000001");
  const afterArchive = await startAndSettle(service, URL);
  assert.equal(afterArchive.workspaceId, "wks_0000000000000002");
  assert.deepEqual(await service.panel({ workspaceId: "wks_0000000000000002" }), {
    status: "ready",
    reviewId: "github/github.com/acme/uploader/7",
    header: HEADER,
    guide: { status: "ready", agentId: "agent-2", guide: sampleLayeredGuide() },
  });
});

test("the review workspaces are the open workspaces of the reviews started here", async (t) => {
  const { service, workspaces, forge } = await withHost(t);
  const other = "https://github.com/acme/uploader/pull/8";
  forge.changeRequests.set(other, sampleChangeRequest(other));

  assert.deepEqual(await service.reviewWorkspaces(), { workspaceIds: [] });
  await startAndSettle(service, URL);
  await startAndSettle(service, other);
  assert.deepEqual(await service.reviewWorkspaces(), { workspaceIds: ["wks_0000000000000001", "wks_0000000000000002"] });

  workspaces.archive("wks_0000000000000001");
  assert.deepEqual(await service.reviewWorkspaces(), { workspaceIds: ["wks_0000000000000002"] });
});

test("the header is re-read on every start, so it follows the PR", async (t) => {
  const { service, forge } = await withHost(t);

  await startAndSettle(service, URL);
  forge.changeRequests.set(URL, sampleChangeRequest(URL, { state: "merged", title: "Retry uploads", additions: 50 }));
  const progress = await startAndSettle(service, URL);

  assert.deepEqual(progress.header, { ...HEADER, state: "merged", title: "Retry uploads", additions: 50 });
});

test("a start after a push keeps the guide at its head, and only the title and state follow the PR", async (t) => {
  const { service, forge, workspaces, guideAgents } = await withHost(t);

  await startAndSettle(service, URL);
  forge.changeRequests.set(URL, sampleChangeRequest(URL, { state: "merged", title: "Retry uploads", headSha: "d".repeat(40), additions: 50 }));
  const progress = await startAndSettle(service, URL);

  assert.deepEqual(progress.header, { ...HEADER, state: "merged", title: "Retry uploads" });
  assert.equal(guideAgents.created.length, 1, "no guide is generated for the new head");
  assert.deepEqual(workspaces.fastForwards, [], "the PR workspace is not moved");
  assert.deepEqual(await service.panel({ workspaceId: progress.workspaceId! }), {
    status: "ready",
    reviewId: "github/github.com/acme/uploader/7",
    header: { ...HEADER, state: "merged", title: "Retry uploads" },
    guide: { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() },
  });
});

/** Has the sample PR's one commit come from #5 on another branch, merged into `main`. */
function carryForeignCommit(forge: FakeForge) {
  forge.commitChangeRequestsAnswer.set("c".repeat(40), [
    { number: 5, url: "https://github.com/acme/uploader/pull/5", title: "Back off", state: "merged", sourceBranch: "backoff", targetBranch: "main" },
  ]);
}

test("the panel says which of the PR's commits belong to another PR, and whether the reviewer wrote it", async (t) => {
  const { service, forge } = await withHost(t);
  carryForeignCommit(forge);

  const progress = await startAndSettle(service, URL);

  const panel = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(panel.status, "ready");
  assert.deepEqual(panel.status === "ready" ? panel.foreign : null, {
    work: {
      targetBranch: "main",
      changeRequests: [
        {
          number: 5,
          url: "https://github.com/acme/uploader/pull/5",
          title: "Back off",
          state: "merged",
          sourceBranch: "backoff",
          targetBranch: "main",
          commits: ["c".repeat(40)],
        },
      ],
      foreignCommits: 1,
      totalCommits: 1,
      truncated: false,
      ownFrom: null,
      ownPaths: null,
    },
    viewerIsAuthor: false,
    scope: null,
  });
});

const [FOREIGN, OWN] = ["e".repeat(40), "f".repeat(40)];

/** Has the sample PR's own commit come after one of #5's, still open, with the files it changes listed. */
function carryForeignWorkBelowOwn(forge: FakeForge) {
  forge.changeRequests.set(
    URL,
    sampleChangeRequest(URL, {
      headSha: OWN,
      commits: [
        { sha: FOREIGN, headline: "Back off", body: "", author: "other", authoredAt: "2026-09-01T10:00:00Z", parents: ["a".repeat(40)] },
        { sha: OWN, headline: "Retry uploads", body: "", author: "author", authoredAt: "2026-09-02T10:00:00Z", parents: [FOREIGN] },
      ],
    }),
  );
  forge.commitChangeRequestsAnswer.set(FOREIGN, [
    { number: 5, url: "https://github.com/acme/uploader/pull/5", title: "Back off", state: "open", sourceBranch: "backoff", targetBranch: "main" },
  ]);
  forge.changedPathsAnswer.set(`${FOREIGN}..${OWN}`, ["src/upload.ts"]);
}

test("own work after another PR's lists the files it changes since the commit it was written on", async (t) => {
  const { service, forge } = await withHost(t);
  const [foreign, own] = [FOREIGN, OWN];
  carryForeignWorkBelowOwn(forge);

  const progress = await startAndSettle(service, URL);

  const panel = await service.panel({ workspaceId: progress.workspaceId! });
  const work = panel.status === "ready" ? panel.foreign?.work : null;
  assert.deepEqual({ ownFrom: work?.ownFrom, ownPaths: work?.ownPaths }, { ownFrom: own, ownPaths: ["src/upload.ts"] });

  forge.changedPathsAnswer.clear();
  await service.regenerate({ reviewId: "github/github.com/acme/uploader/7" });
  await service.settled();
  const unlisted = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(unlisted.status === "ready" ? unlisted.foreign?.work.ownPaths : undefined, null, "a forge that cannot list them leaves none");
});

test("own work that can be told apart has the guide wait for the reviewer to choose what it explains, for every later head", async (t) => {
  const { service, forge, guideAgents } = await withHost(t);
  const reviewId = "github/github.com/acme/uploader/7";
  carryForeignWorkBelowOwn(forge);

  const progress = await startAndSettle(service, URL);

  assert.equal(progress.phase, "ready");
  const waiting = await service.panel({ workspaceId: progress.workspaceId! });
  assert.deepEqual(waiting.status === "ready" ? waiting.guide : null, { status: "choosing-scope", agentId: null });
  assert.equal(guideAgents.created.length, 0, "no guide agent is asked before the choice");
  assert.equal((await service.localReviews({ reviewIds: [reviewId] })).reviews[0]?.local?.guide, "choosing-scope");

  assert.deepEqual(await service.chooseScope({ reviewId, scope: "full" }), { status: "generating", agentId: null });
  await service.settled();
  assert.equal(guideAgents.created.length, 1);

  const next = "d".repeat(40);
  const current = forge.changeRequests.get(URL)!;
  forge.changeRequests.set(URL, { ...current, headSha: next, commits: [...current.commits, { ...current.commits[1]!, sha: next, parents: [OWN] }] });
  forge.changedPathsAnswer.set(`${FOREIGN}..${next}`, ["src/upload.ts"]);
  await service.regenerate({ reviewId });
  await service.settled();
  const moved = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(moved.status === "ready" ? moved.guide.status : null, "ready", "the choice holds at the new head");
  assert.equal(guideAgents.created.length, 2);
});

test("a guide of the own work reads its files and commits only, and lists the others' files apart", async (t) => {
  const { service, forge, guideAgents } = await withHost(t);
  const reviewId = "github/github.com/acme/uploader/7";
  carryForeignWorkBelowOwn(forge);
  const [retryPolicy] = sampleGuide().nodes;
  guideAgents.answer = () =>
    sampleGuideReply({ ...sampleGuide(), nodes: [{ ...retryPolicy!, covers: [{ path: "src/upload.ts", hunks: [], lines: [] }] }] });
  const progress = await startAndSettle(service, URL);

  await service.chooseScope({ reviewId, scope: "own" });
  await service.settled();

  const prompt = guideAgents.created[0]!.prompt;
  assert.match(prompt, /This guide is of the pull request's own work only\. Its branch also carries the commits of #5/);
  assert.match(prompt, new RegExp(`- The commits: \`git log ${OWN}\\^1\\.\\.${OWN}\``));
  assert.match(prompt, new RegExp(`- The file list: \`git diff --name-status -M ${OWN}\\^1 ${OWN}\``));
  assert.match(prompt, new RegExp(`-M ${"a".repeat(40)}\\.\\.\\.${OWN} -- <path>`), "hunks are still numbered as the whole diff cuts them");

  const panel = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(panel.status, "ready");
  const guide = panel.status === "ready" && panel.guide.status === "ready" ? panel.guide.guide : null;
  assert.deepEqual(guide?.supporting, [{ path: "src/retry.ts", category: "foreign" }]);
  assert.deepEqual((await service.readingProgress({ reviewId }))?.foreign, { understood: 0, total: 1 });
});

test("a guide of the whole diff, chosen, reads every file and commit", async (t) => {
  const { service, forge, guideAgents } = await withHost(t);
  carryForeignWorkBelowOwn(forge);
  await startAndSettle(service, URL);

  await service.chooseScope({ reviewId: "github/github.com/acme/uploader/7", scope: "full" });
  await service.settled();

  const prompt = guideAgents.created[0]!.prompt;
  assert.doesNotMatch(prompt, /own work only/);
  assert.match(prompt, new RegExp(`- The commits: \`git log ${"a".repeat(40)}\\.\\.${OWN}\``));
  assert.match(prompt, new RegExp(`- The file list: \`git diff --name-status -M ${"a".repeat(40)}\\.\\.\\.${OWN}\``));
});

test("switching the guide to the own work writes a new one at the same head, and the marks carry over to the same code", async (t) => {
  const { service, forge, guideAgents } = await withHost(t);
  const reviewId = "github/github.com/acme/uploader/7";
  carryForeignWorkBelowOwn(forge);
  const progress = await startAndSettle(service, URL);
  await service.chooseScope({ reviewId, scope: "full" });
  await service.settled();
  await service.setUnderstood({ reviewId, headSha: OWN, subjects: [{ kind: "node", nodeId: "uploader" }], understood: true });
  const full = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(full.status === "ready" ? full.foreign?.scope : undefined, "full");

  const [, uploader] = sampleGuide().nodes;
  guideAgents.answer = () =>
    sampleGuideReply({
      ...sampleGuide(),
      overview: { ...sampleGuide().overview, attention: [{ nodeId: "own-uploader", reason: "It is all there is." }] },
      nodes: [{ ...uploader!, id: "own-uploader", dependencies: [] }],
    });
  assert.deepEqual(await service.chooseScope({ reviewId, scope: "own" }), { status: "generating", agentId: null });
  await assert.rejects(service.chooseScope({ reviewId, scope: "full" }), /being written/);
  await service.settled();

  const own = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(own.status === "ready" ? own.foreign?.scope : undefined, "own");
  assert.deepEqual(guideAgents.archived, ["agent-1"]);
  assert.deepEqual((await service.readingProgress({ reviewId }))?.understood, { nodes: ["own-uploader"], files: [] });

  assert.deepEqual(await service.chooseScope({ reviewId, scope: "own" }), own.status === "ready" ? own.guide : null, "the same scope again writes nothing");
  assert.equal(guideAgents.created.length, 2);
});

test("a scope is not chosen for a PR whose own work cannot be told apart", async (t) => {
  const { service, forge } = await withHost(t);
  carryForeignCommit(forge);
  await startAndSettle(service, URL);

  await assert.rejects(service.chooseScope({ reviewId: "github/github.com/acme/uploader/7", scope: "own" }), /cannot be told apart/);
});

test("a forge that cannot say which PRs the commits belong to leaves the start to go ahead with none", async (t) => {
  const { service, forge } = await withHost(t);
  carryForeignCommit(forge);
  forge.failCommitChangeRequests = new ForgeError("gh failed: HTTP 502");

  const progress = await startAndSettle(service, URL);

  assert.equal(progress.phase, "ready");
  const panel = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(panel.status === "ready" && "foreign" in panel, false);
});

test("a start after a push keeps the foreign work read at the guide's head, and Regenerate reads it at the new one", async (t) => {
  const { service, forge } = await withHost(t);
  carryForeignCommit(forge);
  const progress = await startAndSettle(service, URL);
  forge.commitChangeRequestsAnswer.clear();
  forge.changeRequests.set(URL, sampleChangeRequest(URL, { headSha: "d".repeat(40) }));

  await startAndSettle(service, URL);
  const kept = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(kept.status === "ready" ? kept.foreign?.work.foreignCommits : null, 1);

  await service.regenerate({ reviewId: "github/github.com/acme/uploader/7" });
  await service.settled();
  const regenerated = await service.panel({ workspaceId: progress.workspaceId! });
  assert.equal(regenerated.status === "ready" && "foreign" in regenerated, false);
});

test("the heads-up goes to the PR as a discussion, never on the reviewer's own PR nor on one with no foreign work", async (t) => {
  const { service, forge } = await withHost(t);
  const reviewId = "github/github.com/acme/uploader/7";
  await startAndSettle(service, URL);
  await assert.rejects(service.postHeadsUp({ reviewId, body: "Retarget, please." }), /carries no other PR's commits/);

  carryForeignCommit(forge);
  await service.regenerate({ reviewId });
  await service.settled();
  await assert.rejects(service.postHeadsUp({ reviewId, body: "  " }), /empty/);
  await service.postHeadsUp({ reviewId, body: " Retarget, please.\n" });
  assert.deepEqual(forge.discussions, [{ url: URL, body: "Retarget, please." }]);

  forge.viewer = { login: "Author", name: null };
  await service.start({ url: URL });
  await service.settled();
  await assert.rejects(service.postHeadsUp({ reviewId, body: "Retarget, please." }), /your own PR/);
  assert.equal(forge.discussions.length, 1);
});

test("a review survives a plugin restart, and keeps what the forge said at its head SHA", async (t) => {
  const { service, restart, data } = await withHost(t);

  const { workspaceId } = await startAndSettle(service, URL);
  const restarted = restart();

  assert.deepEqual(await restarted.panel({ workspaceId: workspaceId! }), {
    status: "ready",
    reviewId: "github/github.com/acme/uploader/7",
    header: HEADER,
    guide: { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() },
  });
  assert.deepEqual(await restarted.startProgress({ reviewId: "github/github.com/acme/uploader/7" }), {
    phase: "ready",
    header: HEADER,
    workspaceId,
    message: null,
  });
  const snapshot = JSON.parse(
    await readFile(path.join(data, "reviews", "github", "github.com", "acme", "uploader", "7", "snapshots", `${"b".repeat(40)}.json`), "utf8"),
  );
  assert.deepEqual(snapshot, sampleChangeRequest(URL));
});

test("a forge that cannot read the PR fails the start with its reason", async (t) => {
  const { service, forge, workspaces } = await withHost(t);
  forge.failFetch = new ForgeError("gh failed: HTTP 401: Bad credentials");

  const progress = await startAndSettle(service, URL);

  assert.deepEqual(progress, {
    phase: "failed",
    header: null,
    workspaceId: null,
    message: `Could not read ${URL}: gh failed: HTTP 401: Bad credentials`,
  });
  assert.deepEqual(workspaces.created, []);
});

test("a workspace Paseo cannot create fails the start, and a retry starts over", async (t) => {
  const { service, workspaces } = await withHost(t);
  workspaces.failCreate = new Error("Unable to resolve repository default branch");

  const failed = await startAndSettle(service, URL);
  assert.deepEqual(failed, {
    phase: "failed",
    header: HEADER,
    workspaceId: null,
    message: `Could not create a workspace for ${URL}: Unable to resolve repository default branch`,
  });
  assert.deepEqual(await service.panel({ workspaceId: "wks_0000000000000001" }), { status: "none" });

  const retried = await startAndSettle(service, URL);
  assert.equal(retried.phase, "ready");
});

test("a workspace with no review in it, and a review this daemon never started, say so", async (t) => {
  const { service } = await withHost(t);

  assert.deepEqual(await service.panel({ workspaceId: "wks_ffffffffffffffff" }), { status: "none" });
  assert.deepEqual(await service.startProgress({ reviewId: "github/github.com/acme/other/1" }), {
    phase: "unknown",
    header: null,
    workspaceId: null,
    message: null,
  });
});

test("a start while one is running follows the running one", async (t) => {
  const { service, workspaces } = await withHost(t);

  const first = await service.start({ url: URL });
  const second = await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(second, first);
  assert.equal(workspaces.created.length, 1);
});

test("a description image comes back with its format and size, and one the forge cannot give or the panel cannot draw says why", async (t) => {
  const { service, forge } = await withHost(t);
  await startAndSettle(service, URL);
  const reviewId = "github/github.com/acme/uploader/7";
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(594, 16);
  png.writeUInt32BE(890, 20);
  forge.attachments.set("https://github.com/user-attachments/assets/shot", png);
  forge.attachments.set("https://github.com/user-attachments/assets/vector", Buffer.from("<svg></svg>"));
  forge.attachments.set("https://github.com/user-attachments/assets/gone", new ForgeError("gh failed: Not Found (HTTP 404)"));

  const image = (url: string) => service.descriptionImage({ reviewId, url });
  assert.deepEqual(await image("https://github.com/user-attachments/assets/shot"), {
    status: "image",
    mimeType: "image/png",
    width: 594,
    height: 890,
    base64: png.toString("base64"),
  });
  assert.deepEqual(await image("https://github.com/user-attachments/assets/vector"), {
    status: "unavailable",
    message: "It is not a PNG, JPEG, GIF or WebP image, which is all the panel draws.",
  });
  assert.deepEqual(await image("https://github.com/user-attachments/assets/gone"), { status: "unavailable", message: "gh failed: Not Found (HTTP 404)" });
  assert.deepEqual(await image("https://img.shields.io/badge/ci.svg"), { status: "unavailable", message: "It is hosted elsewhere, so it opens in the browser." });
});
