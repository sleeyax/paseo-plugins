import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { LayeredGuide } from "../shared/guide.ts";
import { summariseProgress } from "../shared/progress.ts";
import { fakeForge, sampleChangeRequest } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import type { ChangedFile } from "./forge/port.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { ReviewService } from "./review-service.ts";

/** Marking the guide understood, driven through the RPCs the panel calls, with what is kept on disk. */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";
const HEAD = "b".repeat(40);

/** Beside `sampleChangeRequest`'s files: a test the guide puts in Supporting, and a doc it places nowhere. */
const RETRY_TEST: ChangedFile = { path: "src/retry.test.ts", previousPath: null, status: "added", additions: 20, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+t" };
const RETRY_DOC: ChangedFile = { path: "docs/retry.md", previousPath: null, status: "added", additions: 12, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+d" };

type Host = { data: string; service: ReviewService; agents: FakeGuideAgents; restart(): ReviewService };

test("Supporting's tests are tallied as Tests, apart from the rest of Supporting", () => {
  const guide = {
    ...sampleGuide(),
    nodes: [],
    supporting: [
      { path: RETRY_TEST.path, category: "test" },
      { path: RETRY_DOC.path, category: "docs" },
    ],
    unsorted: [],
  } satisfies LayeredGuide;

  const progress = summariseProgress(guide, HEAD, { nodes: [], files: [RETRY_DOC.path] });

  assert.deepEqual(progress.tests, { understood: 0, total: 1 });
  assert.deepEqual(progress.supporting, { understood: 1, total: 1 });
  assert.deepEqual(progress.overall, { understood: 1, total: 2 });
});

async function withHost(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-progress-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  const changeRequest = sampleChangeRequest(URL);
  forge.changeRequests.set(URL, { ...changeRequest, files: [...changeRequest.files, RETRY_TEST, RETRY_DOC] });
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply({ ...sampleGuide(), supporting: [{ path: RETRY_TEST.path, category: "test" }] });
  const create = () => new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  return { data, service: create(), agents, restart: create };
}

async function withGuide(t: TestContext): Promise<Host> {
  const host = await withHost(t);
  await host.service.start({ url: URL });
  await host.service.settled();
  return host;
}

const NOTHING_UNDERSTOOD = {
  headSha: HEAD,
  understood: { nodes: [], files: [] },
  layers: [
    { understood: 0, total: 1 },
    { understood: 0, total: 1 },
  ],
  tests: { understood: 0, total: 1 },
  supporting: { understood: 0, total: 0 },
  unsorted: { understood: 0, total: 1 },
  overall: { understood: 0, total: 4 },
  nextLayer: 0,
};

test("a ready guide starts with nothing understood, tallied per layer, Tests, Supporting, Unsorted and overall", async (t) => {
  const { service } = await withGuide(t);

  assert.deepEqual(await service.readingProgress({ reviewId: REVIEW_ID }), NOTHING_UNDERSTOOD);
});

test("marking the trunk understood moves the next layer on, and the marks are kept on disk under the head SHA", async (t) => {
  const { service, data } = await withGuide(t);

  const progress = await service.setUnderstood({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    subject: { kind: "node", nodeId: "retry-policy" },
    understood: true,
  });

  assert.deepEqual(progress, {
    ...NOTHING_UNDERSTOOD,
    understood: { nodes: ["retry-policy"], files: [] },
    layers: [
      { understood: 1, total: 1 },
      { understood: 0, total: 1 },
    ],
    overall: { understood: 1, total: 4 },
    nextLayer: 1,
  });
  assert.deepEqual(await service.readingProgress({ reviewId: REVIEW_ID }), progress);

  const onDisk = JSON.parse(await readFile(path.join(data, "reviews", ...REVIEW_ID.split("/"), "progress", `${HEAD}.json`), "utf8"));
  assert.deepEqual({ ...onDisk, updatedAt: "" }, { headSha: HEAD, agentId: "agent-1", nodes: ["retry-policy"], files: [], updatedAt: "" });
});

test("Supporting and Unsorted entries are marked by path, and every node understood leaves no next layer", async (t) => {
  const { service } = await withGuide(t);
  const mark = (subject: Parameters<ReviewService["setUnderstood"]>[0]["subject"]) =>
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject, understood: true });

  await mark({ kind: "node", nodeId: "uploader" });
  await mark({ kind: "file", path: "docs/retry.md" });
  await mark({ kind: "file", path: "src/retry.test.ts" });
  const progress = await mark({ kind: "node", nodeId: "retry-policy" });

  assert.deepEqual(progress, {
    headSha: HEAD,
    // In the guide's order, whatever the order they were marked in.
    understood: { nodes: ["retry-policy", "uploader"], files: ["src/retry.test.ts", "docs/retry.md"] },
    layers: [
      { understood: 1, total: 1 },
      { understood: 1, total: 1 },
    ],
    tests: { understood: 1, total: 1 },
    supporting: { understood: 0, total: 0 },
    unsorted: { understood: 1, total: 1 },
    overall: { understood: 4, total: 4 },
    nextLayer: null,
  });
});

test("clearing a mark takes it back, and marking twice counts once", async (t) => {
  const { service } = await withGuide(t);
  const set = (nodeId: string, understood: boolean) =>
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId }, understood });

  await set("retry-policy", true);
  await set("retry-policy", true);
  await set("uploader", true);
  assert.deepEqual((await set("retry-policy", false)).understood, { nodes: ["uploader"], files: [] });
  assert.deepEqual(await set("uploader", false), NOTHING_UNDERSTOOD);
  assert.deepEqual(await set("uploader", false), NOTHING_UNDERSTOOD);
});

test("toggles sent at once all land", async (t) => {
  const { service } = await withGuide(t);

  await Promise.all([
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "retry-policy" }, understood: true }),
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "uploader" }, understood: true }),
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "file", path: "docs/retry.md" }, understood: true }),
  ]);

  assert.deepEqual((await service.readingProgress({ reviewId: REVIEW_ID }))?.understood, {
    nodes: ["retry-policy", "uploader"],
    files: ["docs/retry.md"],
  });
});

test("progress survives a restart, including a mark cleared before it", async (t) => {
  const { service, restart } = await withGuide(t);
  await service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "retry-policy" }, understood: true });
  await service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "file", path: "src/retry.test.ts" }, understood: true });
  await service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "retry-policy" }, understood: false });

  const restarted = restart();

  assert.deepEqual((await restarted.readingProgress({ reviewId: REVIEW_ID }))?.understood, { nodes: [], files: ["src/retry.test.ts"] });
  await restarted.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "uploader" }, understood: true });
  assert.deepEqual((await restart().readingProgress({ reviewId: REVIEW_ID }))?.understood, {
    nodes: ["uploader"],
    files: ["src/retry.test.ts"],
  });
});

test("a guide generated again at the same head starts with nothing understood", async (t) => {
  const { service } = await withGuide(t);
  await service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "retry-policy" }, understood: true });

  await service.generateGuide({ reviewId: REVIEW_ID });
  assert.equal(await service.readingProgress({ reviewId: REVIEW_ID }), null);
  await assert.rejects(
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "uploader" }, understood: true }),
    { message: "There is no finished guide to mark progress in." },
  );
  await service.settled();

  assert.deepEqual(await service.readingProgress({ reviewId: REVIEW_ID }), NOTHING_UNDERSTOOD);
});

test("only a node, a Supporting entry or an Unsorted entry of a finished guide can be marked", async (t) => {
  const { service, agents } = await withHost(t);
  let release!: (reply: string) => void;
  const reply = new Promise<string>((resolve) => (release = resolve));
  agents.answer = () => reply;
  await service.start({ url: URL });
  while (agents.created.length === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await service.readingProgress({ reviewId: REVIEW_ID }), null);
  await assert.rejects(
    service.setUnderstood({ reviewId: REVIEW_ID, headSha: HEAD, subject: { kind: "node", nodeId: "retry-policy" }, understood: true }),
    { message: "There is no finished guide to mark progress in." },
  );

  release(sampleGuideReply({ ...sampleGuide(), supporting: [{ path: RETRY_TEST.path, category: "test" }] }));
  await service.settled();

  const set = (subject: Parameters<ReviewService["setUnderstood"]>[0]["subject"], headSha = HEAD) =>
    service.setUnderstood({ reviewId: REVIEW_ID, headSha, subject, understood: true });
  await assert.rejects(set({ kind: "node", nodeId: "backoff" }), { message: "That concept is not in the guide any more." });
  // A node's own file is understood with its node.
  await assert.rejects(set({ kind: "file", path: "src/retry.ts" }), {
    message: "src/retry.ts is not a Supporting or Unsorted file of the guide.",
  });
  await assert.rejects(set({ kind: "node", nodeId: "uploader" }, "c".repeat(40)), { message: "There is no finished guide to mark progress in." });
  await assert.rejects(
    service.setUnderstood({
      reviewId: "github/github.com/acme/uploader/8",
      headSha: HEAD,
      subject: { kind: "node", nodeId: "uploader" },
      understood: true,
    }),
    { message: "This review is not known here any more. Start it again." },
  );
  assert.equal(await service.readingProgress({ reviewId: "github/github.com/acme/uploader/8" }), null);
  assert.deepEqual(await service.readingProgress({ reviewId: REVIEW_ID }), NOTHING_UNDERSTOOD);
});
