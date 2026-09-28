import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Draft } from "../shared/drafts.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import type { ChangedFile } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * Draft comments, driven through the RPCs the panel calls, with what reaches the forge: the lines a
 * location names are looked up in the diff at the review's head, and sent with everything either
 * forge anchors a comment by.
 */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";

/**
 * Two hunks: the first with unchanged, removed and added lines, whose old and new numbers part ways,
 * the second further down.
 */
const UPLOAD: ChangedFile = {
  path: "src/upload.ts",
  previousPath: "src/send.ts",
  status: "renamed",
  additions: 3,
  deletions: 2,
  patch: [
    "@@ -10,5 +10,6 @@ export async function upload(file) {",
    " const a = 1;",
    " const b = 2;",
    "-send(file);",
    "+await retry(() => send(file));",
    '+log("sent");',
    " return true;",
    " }",
    "@@ -40,3 +41,3 @@ function other() {",
    " x();",
    "-y();",
    "+z();",
    " w();",
  ].join("\n"),
};

const LOGO: ChangedFile = { path: "assets/logo.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null };

async function withReview(t: TestContext): Promise<{ service: ReviewService; forge: FakeForge }> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-drafts-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  const changeRequest = sampleChangeRequest(URL);
  forge.changeRequests.set(URL, { ...changeRequest, files: [UPLOAD, changeRequest.files[1]!, LOGO] });
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents, dataDirectory: data });
  await service.start({ url: URL });
  await service.settled();
  return { service, forge };
}

const HEAD = "b".repeat(40);

const TARGET = {
  ref: { forge: "github", host: "github.com", project: "acme/uploader", number: 7, url: URL },
  baseSha: "a".repeat(40),
  startSha: "a".repeat(40),
  headSha: HEAD,
};
const ON_UPLOAD = { path: "src/upload.ts", previousPath: "src/send.ts" };

test("a comment on an added, a removed or an unchanged line reaches the forge with all either forge anchors it by", async (t) => {
  const { service, forge } = await withReview(t);

  const added = await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "line", path: "src/upload.ts", line: { side: "new", line: 13 } },
    body: "  Is logging every upload too much?\n",
  });
  await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "line", path: "src/upload.ts", line: { side: "old", line: 12 } },
    body: "Was this ever awaited?",
  });
  await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "line", path: "src/upload.ts", line: { side: "new", line: 14 } },
    body: "Still true on a retry?",
  });

  assert.deepEqual(forge.created, [
    {
      target: TARGET,
      anchor: { kind: "line", ...ON_UPLOAD, line: { kind: "added", oldLine: null, newLine: 13, oldPos: 13, newPos: 13 } },
      body: "Is logging every upload too much?",
    },
    {
      target: TARGET,
      anchor: { kind: "line", ...ON_UPLOAD, line: { kind: "removed", oldLine: 12, newLine: null, oldPos: 12, newPos: 12 } },
      body: "Was this ever awaited?",
    },
    {
      target: TARGET,
      anchor: { kind: "line", ...ON_UPLOAD, line: { kind: "context", oldLine: 13, newLine: 14, oldPos: 13, newPos: 14 } },
      body: "Still true on a retry?",
    },
  ]);
  assert.deepEqual(added, {
    id: "draft-1",
    body: "Is logging every upload too much?",
    location: { kind: "line", path: "src/upload.ts", line: { side: "new", line: 13 } },
  });
});

test("an unchanged line can be named by its old number too", async (t) => {
  const { service, forge } = await withReview(t);

  await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "line", path: "src/upload.ts", line: { side: "old", line: 42 } },
    body: "Why keep w?",
  });

  assert.deepEqual(forge.created[0]?.anchor, {
    kind: "line",
    ...ON_UPLOAD,
    line: { kind: "context", oldLine: 42, newLine: 43, oldPos: 42, newPos: 43 },
  });
});

test("a range within one hunk is sent in the diff's order, however it was dragged", async (t) => {
  const { service, forge } = await withReview(t);

  // Dragged upwards, from the second added line to the removed one.
  const draft = await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "range", path: "src/upload.ts", start: { side: "new", line: 13 }, end: { side: "old", line: 12 } },
    body: "This whole change wants a test.",
  });

  assert.deepEqual(forge.created[0]?.anchor, {
    kind: "range",
    ...ON_UPLOAD,
    start: { kind: "removed", oldLine: 12, newLine: null, oldPos: 12, newPos: 12 },
    end: { kind: "added", oldLine: null, newLine: 13, oldPos: 13, newPos: 13 },
  });
  assert.deepEqual(draft.location, {
    kind: "range",
    path: "src/upload.ts",
    start: { side: "old", line: 12 },
    end: { side: "new", line: 13 },
  });
});

test("a range of one line is a comment on that line", async (t) => {
  const { service, forge } = await withReview(t);

  await service.createDraft({
    reviewId: REVIEW_ID,
    headSha: HEAD,
    location: { kind: "range", path: "src/upload.ts", start: { side: "new", line: 42 }, end: { side: "new", line: 42 } },
    body: "z?",
  });

  assert.deepEqual(forge.created[0]?.anchor, {
    kind: "line",
    ...ON_UPLOAD,
    line: { kind: "added", oldLine: null, newLine: 42, oldPos: 42, newPos: 42 },
  });
});

test("a comment on a whole file needs no diff, so a binary file takes one too", async (t) => {
  const { service, forge } = await withReview(t);

  await service.createDraft({ reviewId: REVIEW_ID, headSha: HEAD, location: { kind: "file", path: "src/upload.ts" }, body: "Why the rename?" });
  await service.createDraft({ reviewId: REVIEW_ID, headSha: HEAD, location: { kind: "file", path: "assets/logo.png" }, body: "Is this the new logo?" });

  assert.deepEqual(
    forge.created.map((created) => created.anchor),
    [
      { kind: "file", ...ON_UPLOAD },
      { kind: "file", path: "assets/logo.png", previousPath: null },
    ],
  );
});

test("a comment the forge could not anchor is turned down before anything is sent", async (t) => {
  const { service, forge } = await withReview(t);

  const cases = [
    {
      location: { kind: "line", path: "src/upload.ts", line: { side: "new", line: 30 } },
      body: "Hm.",
      message: "Line 30 of src/upload.ts is not in the diff, so a comment cannot be anchored there.",
    },
    {
      location: { kind: "line", path: "src/upload.ts", line: { side: "old", line: 43 } },
      body: "Hm.",
      message: "Old line 43 of src/upload.ts is not in the diff, so a comment cannot be anchored there.",
    },
    {
      location: { kind: "line", path: "assets/logo.png", line: { side: "new", line: 1 } },
      body: "Hm.",
      message: "Line 1 of assets/logo.png is not in the diff, so a comment cannot be anchored there.",
    },
    {
      location: { kind: "range", path: "src/upload.ts", start: { side: "new", line: 12 }, end: { side: "new", line: 42 } },
      body: "Hm.",
      message: "A comment on several lines has to stay within one hunk of the diff.",
    },
    {
      location: { kind: "file", path: "src/elsewhere.ts" },
      body: "Hm.",
      message: "src/elsewhere.ts is not one of the change's files.",
    },
    {
      location: { kind: "file", path: "src/upload.ts" },
      body: "  \n ",
      message: "Write the comment before saving it.",
    },
  ] as const;

  for (const { location, body, message } of cases) {
    await assert.rejects(service.createDraft({ reviewId: REVIEW_ID, headSha: HEAD, location, body }), new Error(message));
  }
  assert.deepEqual(forge.created, []);
});

test("the panel lists the forge's drafts, including ones started on the web, and edits and deletes them there", async (t) => {
  const { service, forge } = await withReview(t);
  const fromTheWeb: Draft = {
    id: "PRRC_web",
    body: "Started on github.com",
    location: { kind: "line", path: "src/retry.ts", line: { side: "new", line: 1 } },
  };
  forge.drafts.set(URL, [fromTheWeb]);

  const created = await service.createDraft({ reviewId: REVIEW_ID, headSha: HEAD, location: { kind: "file", path: "src/upload.ts" }, body: "Why?" });
  assert.deepEqual(await service.listDrafts({ reviewId: REVIEW_ID }), { drafts: [fromTheWeb, created] });

  assert.equal(await service.updateDraft({ reviewId: REVIEW_ID, draftId: "PRRC_web", body: " Edited in the panel. " }), null);
  assert.equal(await service.deleteDraft({ reviewId: REVIEW_ID, draftId: created.id }), null);

  assert.deepEqual(await service.listDrafts({ reviewId: REVIEW_ID }), {
    drafts: [{ ...fromTheWeb, body: "Edited in the panel." }],
  });
  await assert.rejects(
    service.updateDraft({ reviewId: REVIEW_ID, draftId: "PRRC_web", body: "" }),
    new Error("Write the comment before saving it."),
  );
});

test("a review this daemon does not know has no drafts to show", async (t) => {
  const { service } = await withReview(t);

  await assert.rejects(
    service.listDrafts({ reviewId: "github/github.com/acme/other/1" }),
    new Error("This review is not known here any more. Start it again."),
  );
});
