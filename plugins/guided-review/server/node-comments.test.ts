import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Draft } from "../shared/drafts.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import type { ForgeKind } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * Comments on a node, driven through the RPCs the panel calls: an MR-level draft note on GitLab, a
 * paragraph of the pending review's body on GitHub, and the link to the node kept on disk, never
 * sent to the forge.
 */

const URLS: Record<ForgeKind, string> = {
  github: "https://github.com/acme/uploader/pull/7",
  gitlab: "https://gitlab.com/acme/uploader/-/merge_requests/7",
};
const REVIEW_IDS: Record<ForgeKind, string> = {
  github: "github/github.com/acme/uploader/7",
  gitlab: "gitlab/gitlab.com/acme/uploader/7",
};
const HEAD = "b".repeat(40);
const GENERAL = { kind: "general" } as const;

type Host = { data: string; forge: FakeForge; service: ReviewService; url: string; reviewId: string; restart(): ReviewService };

async function withGuide(t: TestContext, kind: ForgeKind): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-node-comments-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const url = URLS[kind];
  const forge = fakeForge(kind);
  forge.changeRequests.set(url, sampleChangeRequest(url));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set(kind === "github" ? "github.com/acme/uploader" : "gitlab.com/acme/uploader", "/home/r/src/uploader");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const create = () => new ReviewService({ forges: [forge], workspaces, guideAgents, dataDirectory: data });
  const service = create();
  await service.start({ url });
  await service.settled();
  return { data, forge, service, url, reviewId: REVIEW_IDS[kind], restart: create };
}

function commentOn(host: Host, nodeId: string, body: string) {
  return host.service.createDraft({ reviewId: host.reviewId, headSha: HEAD, location: GENERAL, body, nodeId });
}

/** Everything the plugin keeps on disk about a review's drafts. */
async function kept(host: Host): Promise<unknown> {
  return JSON.parse(await readFile(path.join(host.data, "reviews", ...host.reviewId.split("/"), "drafts.json"), "utf8"));
}

test("on GitLab a node's comment is an MR-level draft note, and only the plugin knows its node", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;

  const draft = await commentOn(host, "retry-policy", "  About the retry handling: why full jitter?\n");

  assert.deepEqual(forge.created.map(({ anchor, body }) => ({ anchor, body })), [
    { anchor: { kind: "general" }, body: "About the retry handling: why full jitter?" },
  ]);
  assert.deepEqual(draft, { id: "draft-1", body: "About the retry handling: why full jitter?", location: GENERAL, nodeId: "retry-policy" });
  assert.deepEqual(await kept(host), {
    links: { "draft-1": { nodeId: "retry-policy", headSha: HEAD, agentId: "agent-1" } },
    paragraphs: [],
  });
  assert.equal(await service.finish({ reviewId }).then((view) => view.body), "", "the review body is the reviewer's alone");

  // One started on the web has no node; the link survives a restart.
  const fromTheWeb: Draft = { id: "88", body: "Overall fine.", location: GENERAL };
  forge.drafts.set(host.url, [...forge.drafts.get(host.url)!, fromTheWeb]);
  assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [draft, { ...fromTheWeb, nodeId: null }]);

  await service.updateDraft({ reviewId, draftId: draft.id, body: "About the retry handling: why jitter at all?" });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts[0], { ...draft, body: "About the retry handling: why jitter at all?" });

  await service.deleteDraft({ reviewId, draftId: draft.id });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [{ ...fromTheWeb, nodeId: null }]);
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
});

test("on GitHub a node's comment is a paragraph of the pending review's body, after the reviewer's own text", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  await service.saveReviewBody({ reviewId, body: "Looks good overall." });

  const retry = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  const upload = await commentOn(host, "uploader", "About the upload loop: is every attempt logged?");

  assert.deepEqual(forge.created, [], "no thread is started");
  assert.equal(forge.bodies.get(url), "Looks good overall.\n\nAbout the retry handling: why full jitter?\n\nAbout the upload loop: is every attempt logged?");
  assert.match(retry.id, /^paragraph-/);
  assert.deepEqual(retry, { id: retry.id, body: "About the retry handling: why full jitter?", location: GENERAL, nodeId: "retry-policy" });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [retry, upload]);

  // Finish review shows and saves the reviewer's own text; the node comments stay where they are.
  assert.equal((await service.finish({ reviewId })).body, "Looks good overall.");
  await service.saveReviewBody({ reviewId, body: "Looks good.\n\nTwo questions." });
  assert.equal(forge.bodies.get(url), `Looks good.\n\nTwo questions.\n\n${retry.body}\n\n${upload.body}`);

  await service.updateDraft({ reviewId, draftId: retry.id, body: "About the retry handling: why jitter at all?" });
  await service.deleteDraft({ reviewId, draftId: upload.id });
  assert.equal(forge.bodies.get(url), "Looks good.\n\nTwo questions.\n\nAbout the retry handling: why jitter at all?");
  assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [{ ...retry, body: "About the retry handling: why jitter at all?" }]);
  assert.deepEqual(await kept(host), {
    links: { [retry.id]: { nodeId: "retry-policy", headSha: HEAD, agentId: "agent-1" } },
    paragraphs: [{ id: retry.id, body: "About the retry handling: why jitter at all?" }],
  });
});

test("on GitHub a node comment edited on the web becomes part of the reviewer's own text, which loses nothing", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  const retry = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  const upload = await commentOn(host, "uploader", "About the upload loop: is every attempt logged?");

  // GitHub's web page keeps what it is sent with CRLF line ends.
  forge.bodies.set(url, `Written on the web.\r\n\r\n${retry.body} And the cap?\r\n\r\n${upload.body}`);

  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [upload]);
  assert.equal((await service.finish({ reviewId })).body, `Written on the web.\n\n${retry.body} And the cap?`);
  await assert.rejects(
    service.updateDraft({ reviewId, draftId: retry.id, body: "Anything." }),
    new Error("This comment is no longer in your pending review's body as it was written; it was edited or removed on GitHub."),
  );
});

test("on GitHub the node comments are published with the body, and nothing is kept of them after", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");

  const result = await service.submit({ reviewId, headSha: HEAD, verdict: "comment", body: "Looks good overall." });

  assert.equal(result.status, "submitted");
  assert.equal(forge.submissions[0]?.submission.body, "Looks good overall.\n\nAbout the retry handling: why full jitter?");
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, []);
});

test("on GitLab the node comments are MR-level drafts the publish takes along, so the body sent is the reviewer's alone", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  await service.saveReviewBody({ reviewId, body: "Looks good overall." });

  const result = await service.submit({ reviewId, headSha: HEAD, verdict: "comment", body: "Looks good overall." });

  assert.equal(result.status, "submitted");
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "comment", body: "Looks good overall." });
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, []);
});

test("a submit that did not publish keeps every node comment and link, on either forge", async (t) => {
  for (const kind of ["github", "gitlab"] as const) {
    const host = await withGuide(t, kind);
    const { forge, service, reviewId } = host;
    const draft = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
    const before = await kept(host);
    forge.submitOutcome = {
      published: false,
      steps: [{ id: "publish", label: "Publish your drafts", status: "failed", message: "HTTP 500" }],
    };

    const result = await service.submit({ reviewId, headSha: HEAD, verdict: "comment", body: "Looks good overall." });

    assert.equal(result.status, "failed", kind);
    assert.deepEqual(await kept(host), before, kind);
    assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [draft], kind);
  }
});

test("a discard the forge failed keeps every node comment and link, on either forge", async (t) => {
  for (const kind of ["github", "gitlab"] as const) {
    const host = await withGuide(t, kind);
    const { forge, service, reviewId } = host;
    const draft = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
    const before = await kept(host);
    forge.discardReview = async () => {
      throw new Error("One of your draft notes could not be deleted.");
    };

    await assert.rejects(service.discard({ reviewId }), new Error("One of your draft notes could not be deleted."));

    assert.deepEqual(await kept(host), before, kind);
    assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [draft], kind);
  }
});

test("discarding the review forgets every node comment and link", async (t) => {
  for (const kind of ["github", "gitlab"] as const) {
    const host = await withGuide(t, kind);
    await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");

    await host.service.discard({ reviewId: host.reviewId });

    assert.deepEqual(await kept(host), { links: {}, paragraphs: [] }, kind);
    assert.deepEqual((await host.service.listDrafts({ reviewId: host.reviewId })).drafts, [], kind);
  }
});

test("a comment on code drawn in a node is linked to that node too, and one on another node is refused", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;

  const onCode = await service.createDraft({
    reviewId,
    headSha: HEAD,
    location: { kind: "file", path: "src/upload.ts" },
    body: "Why here?",
    nodeId: "uploader",
  });
  assert.equal(onCode.nodeId, "uploader");
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts.map((draft) => draft.nodeId), ["uploader"]);

  await assert.rejects(commentOn(host, "no-such-node", "Hm."), new Error("That concept is not in the guide any more."));
  assert.equal(forge.created.length, 1, "nothing more was sent");
});
