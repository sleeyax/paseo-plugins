import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { VerdictOption } from "../shared/submit.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError, type ChangeRequest, type ForgeKind } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * Finishing a review, driven through the RPCs the Finish review step calls: which verdicts are on
 * offer, the head asked of the forge again at submit, what reaches the forge, and a submit whose
 * steps did not all land reported step by step.
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
const PUSHED = "d".repeat(40);

type Host = { service: ReviewService; forge: FakeForge; reviewId: string; url: string; changeRequest: ChangeRequest; restart(): ReviewService };

async function withReview(t: TestContext, options: { kind?: ForgeKind; viewer?: string } = {}): Promise<Host> {
  const kind = options.kind ?? "github";
  const url = URLS[kind];
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-submit-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge(kind);
  if (options.viewer) forge.viewer = { login: options.viewer, name: null };
  const changeRequest = sampleChangeRequest(url);
  forge.changeRequests.set(url, changeRequest);
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set(`${kind}.com/acme/uploader`, "/home/r/src/uploader");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const restart = () => new ReviewService({ forges: [forge], workspaces, guideAgents, dataDirectory: data });
  const service = restart();
  await service.start({ url });
  await service.settled();
  return { service, forge, reviewId: REVIEW_IDS[kind], url, changeRequest, restart };
}

function allowed(verdicts: VerdictOption[]): string[] {
  return verdicts.filter((option) => option.allowed).map((option) => option.verdict);
}

test("on someone else's open PR at the guide's head every verdict is on offer, and a submit sends the body with it", async (t) => {
  const { service, forge, reviewId, changeRequest } = await withReview(t);
  await service.saveReviewBody({ reviewId, body: "Started earlier" });

  const finish = await service.finish({ reviewId });
  assert.equal(finish.body, "Started earlier");
  assert.deepEqual(allowed(finish.verdicts), ["approve", "request-changes", "comment"]);
  assert.equal(finish.head.moved, false);

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "  Reads well.\n" });

  assert.deepEqual(result, {
    status: "submitted",
    published: true,
    steps: [{ id: "submit", label: "Publish the review", status: "done", message: null }],
  });
  assert.deepEqual(forge.submissions, [
    {
      target: { ref: changeRequest.ref, baseSha: changeRequest.baseSha, startSha: changeRequest.startSha, headSha: HEAD },
      submission: { verdict: "approve", body: "Reads well.", approveHeadSha: HEAD },
    },
  ]);
});

test("on the reviewer's own PR only Comment is on offer, and an approval is refused with nothing sent", async (t) => {
  // The forge takes a username in any case.
  const { service, forge, reviewId } = await withReview(t, { viewer: "Author" });

  const finish = await service.finish({ reviewId });
  assert.deepEqual(allowed(finish.verdicts), ["comment"]);
  assert.deepEqual(finish.verdicts[0], {
    verdict: "approve",
    allowed: false,
    reason: "This is your own PR, so your review can only comment.",
    warning: null,
    regenerate: false,
  });

  const refused = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "request-changes", body: "" });
  assert.equal(refused.status, "refused");
  assert.equal(refused.status === "refused" && refused.message, "This is your own PR, so your review can only comment.");
  assert.deepEqual(forge.submissions, []);

  const commented = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Notes to self." });
  assert.equal(commented.status, "submitted");
  assert.equal(forge.submissions.length, 1);
});

test("on a closed or merged PR only Comment is on offer, and drafting is still allowed", async (t) => {
  for (const state of ["closed", "merged"] as const) {
    const { service, forge, reviewId, url, changeRequest } = await withReview(t);
    // The PR was merged after the guide was written: the forge's state now is what counts.
    forge.changeRequests.set(url, { ...changeRequest, state });

    const finish = await service.finish({ reviewId });
    assert.deepEqual(allowed(finish.verdicts), ["comment"], state);
    assert.equal(finish.verdicts[0]?.reason, `This PR is ${state}, so your review can only comment.`, state);

    await service.createDraft({ reviewId, headSha: HEAD, location: { kind: "file", path: "src/retry.ts" }, body: "Worth a follow-up." });
    const refused = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "" });
    assert.equal(refused.status, "refused", state);
    const commented = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "" });
    assert.equal(commented.status, "submitted", state);
    assert.deepEqual(
      forge.submissions.map((submission) => submission.submission.verdict),
      ["comment"],
      state,
    );
  }
});

test("a head moved since the guide leaves every verdict on offer, warning of the new commits and offering to regenerate", async (t) => {
  const { service, forge, reviewId, url, changeRequest } = await withReview(t);
  forge.changeRequests.set(url, { ...changeRequest, headSha: PUSHED });
  forge.commitsSinceAnswer = { kind: "after", count: 3 };

  const finish = await service.finish({ reviewId });
  assert.deepEqual(allowed(finish.verdicts), ["approve", "request-changes", "comment"]);
  assert.deepEqual(finish.verdicts[1], {
    verdict: "request-changes",
    allowed: true,
    reason: null,
    warning: "3 new commits were pushed since this guide (bbbbbbb → ddddddd), so a verdict would apply to code it did not explain. Regenerate the guide to read them first.",
    regenerate: true,
  });
  assert.deepEqual(finish.verdicts[2], { verdict: "comment", allowed: true, reason: null, warning: null, regenerate: false });
  assert.deepEqual(finish.head, { guideHeadSha: HEAD, forgeHeadSha: PUSHED, moved: true, newCommits: 3, rewritten: false, state: "open", message: null });

  const approved = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: PUSHED, verdict: "approve", body: "LGTM" });
  assert.equal(approved.status, "submitted");
  // The review stays on the head the guide explained, where the drafts were anchored; an approval names the forge's.
  assert.equal(forge.submissions[0]?.target.headSha, HEAD);
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "approve", body: "LGTM", approveHeadSha: PUSHED });
});

test("a branch rewritten since the guide says so rather than counting", async (t) => {
  const { service, forge, reviewId, url, changeRequest } = await withReview(t, { kind: "gitlab" });
  forge.changeRequests.set(url, { ...changeRequest, headSha: PUSHED });
  forge.commitsSinceAnswer = { kind: "rewritten" };

  const finish = await service.finish({ reviewId });

  assert.equal(
    finish.verdicts[0]?.warning,
    "The branch was rewritten since this guide (bbbbbbb → ddddddd), so a verdict would apply to code it did not explain. Regenerate the guide to read them first.",
  );
});

test("a push after the step opened refuses a verdict once, so it goes out only under the warning the reviewer saw", async (t) => {
  const { service, forge, reviewId, url, changeRequest } = await withReview(t);
  const finish = await service.finish({ reviewId });
  assert.equal(finish.verdicts[0]?.warning, null);
  const reads = forge.headReads;

  forge.changeRequests.set(url, { ...changeRequest, headSha: PUSHED });
  const refused = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: finish.head.forgeHeadSha, verdict: "approve", body: "LGTM" });

  assert.equal(forge.headReads, reads + 1);
  assert.equal(refused.status, "refused");
  assert.equal(refused.status === "refused" && refused.message, "The PR changed again since Finish review read it. Check the warning and submit again.");
  assert.match(refused.status === "refused" ? (refused.verdicts[0]?.warning ?? "") : "", /new commit was pushed/);
  assert.deepEqual(forge.submissions, []);

  const commented = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: finish.head.forgeHeadSha, verdict: "comment", body: "" });
  assert.equal(commented.status, "submitted", "a comment is never held back by the head");
  const approved = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: PUSHED, verdict: "approve", body: "LGTM" });
  assert.equal(approved.status, "submitted");
});

test("a head the forge cannot be asked about leaves every verdict on offer with a warning, and an approval names no head", async (t) => {
  const { service, forge, reviewId } = await withReview(t, { kind: "gitlab" });

  forge.failFetchHead = new ForgeError("glab failed: connection reset");
  const finish = await service.finish({ reviewId });
  assert.deepEqual(allowed(finish.verdicts), ["approve", "request-changes", "comment"]);
  assert.deepEqual(finish.verdicts[0], {
    verdict: "approve",
    allowed: true,
    reason: null,
    warning:
      "Could not check https://gitlab.com/acme/uploader/-/merge_requests/7 for new commits: glab failed: connection reset. It may have commits the guide did not explain, which a verdict would apply to as well.",
    regenerate: false,
  });

  forge.failFetchHead = new ForgeError("glab failed: connection reset");
  const approved = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: null, verdict: "approve", body: "LGTM" });
  assert.equal(approved.status, "submitted");
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "approve", body: "LGTM", approveHeadSha: null });
});

test("a submit from a guide the review was regenerated away from is refused", async (t) => {
  const { service, forge, reviewId } = await withReview(t);

  const result = await service.submit({ reviewId, headSha: "e".repeat(40), forgeHeadSha: HEAD, verdict: "comment", body: "" });

  assert.equal(result.status, "refused");
  assert.match(result.status === "refused" ? result.message : "", /regenerated for bbbbbbb/);
  assert.deepEqual(forge.submissions, []);
});

test("a submit whose later steps fail says which landed and which did not", async (t) => {
  const { service, forge, reviewId } = await withReview(t);
  const steps = [
    { id: "publish", label: "Publish 3 comments and the review body", status: "done" as const, message: null },
    { id: "approve", label: "Approve", status: "failed" as const, message: "glab failed: 401 Unauthorized" },
    { id: "check", label: "Confirm the reviewer state", status: "skipped" as const, message: "Approving failed." },
  ];
  forge.submitOutcome = { published: true, steps };

  const partial = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "LGTM" });

  assert.deepEqual(partial, { status: "partial", published: true, steps });

  forge.submitOutcome = {
    published: false,
    steps: [{ id: "submit", label: "Publish the review and approve", status: "failed", message: "gh failed: Something went wrong" }],
  };
  const failed = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "approve", body: "LGTM" });
  assert.deepEqual(failed, {
    status: "failed",
    published: false,
    steps: [{ id: "submit", label: "Publish the review and approve", status: "failed", message: "gh failed: Something went wrong" }],
  });
});

test("discarding throws the review away with its drafts and body", async (t) => {
  const { service, forge, reviewId, url } = await withReview(t);
  await service.createDraft({ reviewId, headSha: HEAD, location: { kind: "file", path: "src/retry.ts" }, body: "Why a new file?" });

  await service.saveReviewBody({ reviewId, body: " Mostly questions.\n" });
  assert.equal((await service.finish({ reviewId })).body, "Mostly questions.");

  await service.discard({ reviewId });
  assert.deepEqual(forge.discarded, [url]);
  assert.deepEqual(await service.listDrafts({ reviewId }), { drafts: [] });
  assert.equal((await service.finish({ reviewId })).body, "");
});

for (const kind of ["github", "gitlab"] as const) {
  test(`on ${kind} the body is kept here until it is published`, async (t) => {
    const { service, forge, reviewId, restart } = await withReview(t, { kind });

    await service.saveReviewBody({ reviewId, body: "Mostly questions." });
    assert.equal((await restart().finish({ reviewId })).body, "Mostly questions.", "it survives a restart");

    // A submit whose publish failed keeps the body it was sent, edits included.
    forge.submitOutcome = {
      published: false,
      steps: [{ id: "publish", label: "Publish the drafts and the review body", status: "failed", message: "HTTP 500" }],
    };
    const failed = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Mostly questions, and one ask." });
    assert.equal(failed.status, "failed");
    assert.equal((await service.finish({ reviewId })).body, "Mostly questions, and one ask.");

    const submitted = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Mostly questions, and one ask." });
    assert.equal(submitted.status, "submitted");
    assert.equal(forge.submissions[1]?.submission.body, "Mostly questions, and one ask.");
    assert.equal((await service.finish({ reviewId })).body, "", "a published body is gone");

    await service.saveReviewBody({ reviewId, body: "Second round." });
    await service.discard({ reviewId });
    assert.equal((await service.finish({ reviewId })).body, "", "a discarded body is gone");
  });
}

test("on an MR the reasons say MR", async (t) => {
  const { service, reviewId } = await withReview(t, { kind: "gitlab", viewer: "author" });

  const finish = await service.finish({ reviewId });

  assert.equal(finish.verdicts[0]?.reason, "This is your own MR, so your review can only comment.");
});

test("on a merged MR only Comment goes out, with the body kept here", async (t) => {
  const { service, forge, reviewId, url, changeRequest } = await withReview(t, { kind: "gitlab" });
  forge.changeRequests.set(url, { ...changeRequest, state: "merged" });
  await service.saveReviewBody({ reviewId, body: "After the fact." });

  const refused = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "request-changes", body: "After the fact." });
  assert.equal(refused.status, "refused");
  assert.equal(forge.submissions.length, 0, "nothing was sent");

  const commented = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "After the fact." });
  assert.equal(commented.status, "submitted");
  assert.deepEqual(forge.submissions[0]?.submission, { verdict: "comment", body: "After the fact.", approveHeadSha: HEAD });
});

test("a GitLab submit that published the drafts but not the body keeps the body for another try", async (t) => {
  const { service, forge, reviewId } = await withReview(t, { kind: "gitlab" });
  forge.submitOutcome = {
    published: false,
    steps: [
      { id: "publish", label: "Publish your drafts", status: "done", message: null },
      { id: "note", label: "Post the review body", status: "failed", message: "glab failed: 500 Internal Server Error (HTTP 500)" },
    ],
  };

  const result = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "One question." });

  assert.equal(result.status, "partial");
  assert.equal((await service.finish({ reviewId })).body, "One question.");
});
