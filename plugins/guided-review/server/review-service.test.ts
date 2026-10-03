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

/** Starts a review and waits for its background job, the way the start surface polls it. */
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
