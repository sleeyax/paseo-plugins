import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function node(nodeId: string) {
  return { kind: "node", nodeId } as const;
}

function commentOn(host: Host, nodeId: string, body: string) {
  return host.service.createDraft({ reviewId: host.reviewId, headSha: HEAD, location: GENERAL, body, from: node(nodeId) });
}

function draftsFile(host: Host): string {
  return path.join(host.data, "reviews", ...host.reviewId.split("/"), "drafts.json");
}

/** Everything the plugin keeps on disk about a review's drafts. */
async function kept(host: Host): Promise<unknown> {
  return JSON.parse(await readFile(draftsFile(host), "utf8"));
}

test("on GitLab a node's comment is an MR-level draft note, and only the plugin knows its node", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;

  const draft = await commentOn(host, "retry-policy", "  About the retry handling: why full jitter?\n");

  assert.deepEqual(forge.created.map(({ anchor, body }) => ({ anchor, body })), [
    { anchor: { kind: "general" }, body: "About the retry handling: why full jitter?" },
  ]);
  assert.deepEqual(draft, { id: "draft-1", body: "About the retry handling: why full jitter?", location: GENERAL, from: node("retry-policy"), quote: null });
  assert.deepEqual(await kept(host), {
    links: { "draft-1": { from: node("retry-policy"), headSha: HEAD, agentId: "agent-1" } },
    paragraphs: [],
  });
  assert.equal(await service.finish({ reviewId }).then((view) => view.body), "", "the review body is the reviewer's alone");

  // One started on the web has no node; the link survives a restart.
  const fromTheWeb: Draft = { id: "88", body: "Overall fine.", location: GENERAL };
  forge.drafts.set(host.url, [...forge.drafts.get(host.url)!, fromTheWeb]);
  assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [draft, { ...fromTheWeb, from: null, quote: null }]);

  await service.updateDraft({ reviewId, draftId: draft.id, body: "About the retry handling: why jitter at all?" });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts[0], { ...draft, body: "About the retry handling: why jitter at all?" });

  await service.deleteDraft({ reviewId, draftId: draft.id });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [{ ...fromTheWeb, from: null, quote: null }]);
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
});

test("on GitHub a node's comment is kept here until a submit posts it as a comment of its own", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  await service.saveReviewBody({ reviewId, body: "Looks good overall." });

  const retry = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  const upload = await commentOn(host, "uploader", "About the upload loop: is every attempt logged?");

  assert.deepEqual(forge.created, [], "no thread is started");
  assert.match(retry.id, /^paragraph-/);
  assert.deepEqual(retry, { id: retry.id, body: "About the retry handling: why full jitter?", location: GENERAL, from: node("retry-policy"), quote: null });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [retry, upload]);

  // Finish review shows and saves the reviewer's own text; the node comments stay where they are.
  assert.equal((await service.finish({ reviewId })).body, "Looks good overall.");
  await service.saveReviewBody({ reviewId, body: "Looks good.\n\nTwo questions." });
  assert.equal((await service.finish({ reviewId })).body, "Looks good.\n\nTwo questions.");

  await service.updateDraft({ reviewId, draftId: retry.id, body: "About the retry handling: why jitter at all?" });
  await service.deleteDraft({ reviewId, draftId: upload.id });
  assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [{ ...retry, body: "About the retry handling: why jitter at all?" }]);
  assert.deepEqual(await kept(host), {
    links: { [retry.id]: { from: node("retry-policy"), headSha: HEAD, agentId: "agent-1" } },
    paragraphs: [{ id: retry.id, body: "About the retry handling: why jitter at all?" }],
  });

  await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Looks good.\n\nTwo questions." });
  assert.deepEqual(forge.comments, [{ url, body: "About the retry handling: why jitter at all?" }]);
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "comment", body: "Looks good.\n\nTwo questions.", approveHeadSha: HEAD });
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] }, "a published comment is gone");
});

test("on GitHub each node comment is posted on its own before the review, which carries only the reviewer's text", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  await commentOn(host, "uploader", "About the upload loop:\n\nis every attempt logged?");

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "Looks good overall." });

  assert.deepEqual(result, {
    status: "submitted",
    published: true,
    steps: [
      { id: "comment", label: 'Post your comment "About the retry handling: why full jitter?"', status: "done", message: null },
      { id: "comment", label: 'Post your comment "About the upload loop:…"', status: "done", message: null },
      { id: "submit", label: "Publish the review", status: "done", message: null },
    ],
  });
  assert.deepEqual(forge.comments, [
    { url, body: "About the retry handling: why full jitter?" },
    { url, body: "About the upload loop:\n\nis every attempt logged?" },
  ]);
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "approve", body: "Looks good overall.", approveHeadSha: HEAD });
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, []);
});

test("on GitHub a comment that is not posted stops the submit, and trying again posts none twice", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  const upload = await commentOn(host, "uploader", "About the upload loop: is every attempt logged?");
  forge.failComment = { after: 1, error: new Error("gh failed: HTTP 502") };

  const failed = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "Looks good overall." });

  assert.deepEqual(failed, {
    status: "partial",
    published: false,
    steps: [
      { id: "comment", label: 'Post your comment "About the retry handling: why full jitter?"', status: "done", message: null },
      { id: "comment", label: 'Post your comment "About the upload loop: is every attempt logged?"', status: "failed", message: "gh failed: HTTP 502" },
      { id: "submit", label: "Publish the review", status: "skipped", message: "Not tried, since a comment was not posted." },
    ],
  });
  assert.deepEqual(forge.submissions, []);
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [upload], "the posted comment is no longer a draft");
  assert.equal((await service.finish({ reviewId })).body, "Looks good overall.");

  const retried = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "Looks good overall." });

  assert.equal(retried.status, "submitted");
  assert.deepEqual(forge.comments, [
    { url, body: "About the retry handling: why full jitter?" },
    { url, body: "About the upload loop: is every attempt logged?" },
  ]);
  assert.equal(forge.submissions.length, 1);
});

test("on GitHub a Comment with nothing but node comments posts them and no empty review", async (t) => {
  const host = await withGuide(t, "github");
  const { forge, service, url, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "" });

  assert.equal(result.status, "submitted");
  assert.equal(result.published, true);
  assert.deepEqual(forge.comments, [{ url, body: "About the retry handling: why full jitter?" }]);
  assert.deepEqual(forge.submissions, []);
  assert.deepEqual(forge.discarded, [url], "a pending review left empty is thrown away");
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
});

test("on GitLab the node comments are MR-level drafts the publish takes along, so the body sent is the reviewer's alone", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;
  await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  await service.saveReviewBody({ reviewId, body: "Looks good overall." });

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Looks good overall." });

  assert.equal(result.status, "submitted");
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "comment", body: "Looks good overall.", approveHeadSha: HEAD });
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, []);
});

test("on GitLab a submit that did not publish keeps every node comment and link", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { forge, service, reviewId } = host;
  const draft = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  const before = await kept(host);
  forge.submitOutcome = {
    published: false,
    steps: [{ id: "publish", label: "Publish your drafts", status: "failed", message: "HTTP 500" }],
  };

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Looks good overall." });

  assert.equal(result.status, "failed");
  assert.deepEqual(await kept(host), before);
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts, [draft]);
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
    from: node("uploader"),
  });
  assert.deepEqual(onCode.from, node("uploader"));
  assert.deepEqual((await service.listDrafts({ reviewId })).drafts.map((draft) => draft.from), [node("uploader")]);

  await assert.rejects(commentOn(host, "no-such-node", "Hm."), new Error("That concept is not in the guide any more."));
  assert.equal(forge.created.length, 1, "nothing more was sent");
});

test("a comment on the overview is a general draft on either forge, and the passage highlighted for it is kept locally", async (t) => {
  const passage = "An upload is retried only when the failure is transient";
  for (const kind of ["github", "gitlab"] as const) {
    const host = await withGuide(t, kind);
    const { forge, service, url, reviewId } = host;

    const draft = await service.createDraft({
      reviewId,
      headSha: HEAD,
      location: GENERAL,
      body: "Why is a 429 not transient?",
      from: { kind: "overview" },
      quote: `  ${passage}\n`,
    });

    assert.deepEqual(draft, {
      id: draft.id,
      body: "Why is a 429 not transient?",
      location: GENERAL,
      from: { kind: "overview" },
      quote: { text: passage, earlier: false },
    }, kind);
    if (kind === "github") assert.deepEqual(forge.created, [], kind);
    else assert.deepEqual(forge.created.map(({ anchor, body }) => ({ anchor, body })), [{ anchor: GENERAL, body: "Why is a 429 not transient?" }], kind);
    assert.deepEqual((await kept(host) as { links: unknown }).links, {
      [draft.id]: { from: { kind: "overview" }, quote: passage, headSha: HEAD, agentId: "agent-1" },
    }, kind);
    assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [draft], kind);
  }
});

test("a highlighted passage without the part of the guide it is from is refused, and nothing is sent", async (t) => {
  const host = await withGuide(t, "gitlab");
  await assert.rejects(
    host.service.createDraft({ reviewId: host.reviewId, headSha: HEAD, location: GENERAL, body: "Hm.", quote: "retried" }),
    new Error("A highlighted passage has to come from the guide's overview or one of its concepts."),
  );
  assert.deepEqual(host.forge.created, []);
});

test("a link kept before a draft could come from the overview still names its node", async (t) => {
  const host = await withGuide(t, "gitlab");
  const { service, reviewId } = host;
  const draft = await commentOn(host, "retry-policy", "About the retry handling: why full jitter?");
  await writeFile(draftsFile(host), JSON.stringify({ links: { [draft.id]: { nodeId: "retry-policy", headSha: HEAD, agentId: "agent-1" } }, paragraphs: [] }));

  assert.deepEqual((await host.restart().listDrafts({ reviewId })).drafts, [draft]);
  await service.deleteDraft({ reviewId, draftId: draft.id });
  assert.deepEqual(await kept(host), { links: {}, paragraphs: [] });
});
