import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { CommentSubject } from "../shared/contracts.ts";
import type { DraftLocation } from "../shared/drafts.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import type { ChangedFile } from "./forge/port.ts";
import { GuideAgentError } from "./guide-agent/port.ts";
import { jsonSchemaOf, withOutputSchema } from "./guide-agent/structured.ts";
import { ReviewService } from "./review-service.ts";
import { WordingSchema } from "./wording-prompt.ts";

/**
 * "Suggest wording", driven through the RPCs the panel calls: what reaches the guide agent, what the
 * comment box gets back, and that nothing reaches the forge.
 */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";
const HEAD = "b".repeat(40);

/** Two hunks: the sample guide's "uploader" node covers the first, and no node the second. */
const UPLOAD: ChangedFile = {
  path: "src/upload.ts",
  previousPath: null,
  status: "modified",
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

async function withGuide(t: TestContext): Promise<{ service: ReviewService; forge: FakeForge; agents: FakeGuideAgents }> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-wording-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  const changeRequest = sampleChangeRequest(URL);
  forge.changeRequests.set(URL, { ...changeRequest, files: [UPLOAD, changeRequest.files[1]!] });
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  await service.start({ url: URL });
  await service.settled();
  agents.answer = () => 'Here you go:\n\n```json\n{ "body": "  Why is the upload logged only once it has been sent?  " }\n```';
  return { service, forge, agents };
}

const onCode = (location: DraftLocation): CommentSubject => ({ kind: "code", location });

/** Suggests wording and waits for it, as the panel does. */
async function suggest(service: ReviewService, subject: CommentSubject, prompt: string) {
  const started = await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt });
  if (started.status !== "running") return started;
  await service.settled();
  return service.suggestion({ suggestionId: started.suggestionId });
}

const RULES = [
  "The comment is posted on GitHub as the reviewer's own, where the author and other reviewers read it beside the code. None of them has seen your guide, so it must read correctly without it.",
  "- Do not use the guide's vocabulary: no trunk, leaf, node or layer, no titles or IDs from the guide, and no mention of the guide or of this chat. Name code by its files, functions and behaviour.",
  "- Word only what the reviewer wants to say. Do not add bugs, security issues, risks, style problems or fixes of your own.",
  "- Write the comment's text only: no greeting, no sign-off, no preamble, and no file or line the comment's position already gives.",
  "- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.",
].join("\n");

test("suggested wording for a range comes back for the box, from a prompt with the lines, their node and what the reviewer typed", async (t) => {
  const { service, forge, agents } = await withGuide(t);
  const location: DraftLocation = { kind: "range", path: "src/upload.ts", start: { side: "old", line: 12 }, end: { side: "new", line: 13 } };

  const started = await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject: onCode(location), prompt: "  why log after send??  " });
  assert.equal(started.status, "running");
  await service.settled();
  const suggestionId = started.status === "running" ? started.suggestionId : "";
  assert.deepEqual(await service.suggestion({ suggestionId }), {
    status: "ready",
    body: "Why is the upload logged only once it has been sent?",
  });

  assert.deepEqual(agents.created[0]!.sent, [
    withOutputSchema(
      [
        `The reviewer of ${URL} at bbbbbbbbbbbb is writing a review comment and wants you to word it.`,
        [
          "It goes on old line 12 to line 13 of src/upload.ts. The lines as the diff shows them:",
          "```diff",
          "-send(file);",
          "+await retry(() => send(file));",
          '+log("sent");',
          "```",
        ].join("\n"),
        ["The node of your guide this code falls in:", '- "uploader", "Uploader uses the policy": The upload loop asks the policy after each failure.'].join("\n"),
        [
          "What the reviewer typed, as a rough draft or an instruction:",
          "```",
          "why log after send??",
          "```",
          "Turn it into the comment they mean to post: keep their point, their stance and every question they ask, and make it clear and concise. If they wrote an instruction rather than a draft, follow it.",
        ].join("\n"),
        RULES,
      ].join("\n\n"),
      jsonSchemaOf(WordingSchema),
    ),
  ]);

  // The box gets the text; nothing is saved on the forge, and a finished suggestion is handed out once.
  assert.deepEqual(forge.created, []);
  assert.deepEqual(await service.listDrafts({ reviewId: REVIEW_ID }), { drafts: [] });
  assert.deepEqual(await service.suggestion({ suggestionId }), {
    status: "failed",
    message: "The suggestion was lost, most likely to a plugin restart. Try again.",
  });
});

test("a line no node covers says so, and an empty box asks for a question rather than a finding", async (t) => {
  const { service, agents } = await withGuide(t);

  const result = await suggest(service, onCode({ kind: "line", path: "src/upload.ts", line: { side: "new", line: 42 } }), "");
  assert.equal(result.status, "ready");

  const prompt = agents.created[0]!.sent[0]!;
  assert.match(prompt, /It goes on line 42 of src\/upload\.ts\. The line as the diff shows it:\n```diff\n\+z\(\);\n```/);
  assert.match(prompt, /\n\nYour guide does not place this code in any of its nodes\.\n\n/);
  assert.match(prompt, /The reviewer has not typed anything yet\. Suggest a short comment a reviewer could leave here: a question about something/);
  assert.match(prompt, /Do not invent a problem\./);
  assert.doesNotMatch(prompt, /What the reviewer typed/);
});

test("a comment on a whole file names the file and every node that covers part of it", async (t) => {
  const { service, agents } = await withGuide(t);

  assert.equal((await suggest(service, onCode({ kind: "file", path: "src/retry.ts" }), "Explain the jitter")).status, "ready");

  const prompt = agents.created[0]!.sent[0]!;
  assert.match(prompt, /\n\nIt goes on src\/retry\.ts as a whole, not on any line of it\. The file was added, \+12 −0\.\n\n/);
  assert.match(prompt, /The node of your guide this code falls in:\n- "retry-policy", "Retry policy": /);
  assert.match(prompt, /```\nExplain the jitter\n```/);
});

test("what the reviewer typed is fenced so that backticks in it cannot close the fence", async (t) => {
  const { service, agents } = await withGuide(t);

  await suggest(service, onCode({ kind: "file", path: "src/upload.ts" }), "see ```code``` here");

  assert.match(agents.created[0]!.sent[0]!, /\n````\nsee ```code``` here\n````\n/);
});

test("a busy guide agent is not asked, and neither is one already suggesting wording", async (t) => {
  const { service, agents } = await withGuide(t);
  const subject = onCode({ kind: "file", path: "src/upload.ts" });
  const busy = { status: "failed", message: "The guide agent is busy with another answer. Try again once it has finished." };

  agents.created[0]!.status = "busy";
  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt: "hm" }), busy);
  assert.deepEqual(agents.created[0]!.sent, []);

  agents.created[0]!.status = "idle";
  let release!: (reply: string) => void;
  const reply = new Promise<string>((resolve) => (release = resolve));
  agents.answer = () => reply;
  const first = await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt: "hm" });
  assert.equal(first.status, "running");
  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt: "hm" }), busy);
  assert.equal(agents.created[0]!.sent.length, 1);
  assert.deepEqual(await service.suggestion({ suggestionId: first.status === "running" ? first.suggestionId : "" }), first);

  release('{ "body": "Hm." }');
  await service.settled();
  assert.deepEqual(await service.suggestion({ suggestionId: first.status === "running" ? first.suggestionId : "" }), { status: "ready", body: "Hm." });
});

test("an agent that fails, or answers with no wording, is reported and nothing is saved", async (t) => {
  const { service, forge, agents } = await withGuide(t);
  const subject = onCode({ kind: "line", path: "src/upload.ts", line: { side: "new", line: 13 } });

  agents.answer = () => new GuideAgentError("The guide agent is still busy. Wait for it to finish, then try again.");
  assert.deepEqual(await suggest(service, subject, "x"), {
    status: "failed",
    message: "The guide agent is still busy. Wait for it to finish, then try again.",
  });

  agents.answer = () => "I would rather not.";
  assert.deepEqual(await suggest(service, subject, "x"), {
    status: "failed",
    message: "The guide agent's answer did not match what was asked for: the reply holds no JSON.",
  });

  agents.answer = () => '{ "body": "   " }';
  assert.deepEqual(await suggest(service, subject, "x"), { status: "failed", message: "The guide agent suggested no wording. Try again." });
  assert.deepEqual(forge.created, []);
});

test("a gone agent, a guide being written, a place no comment can go and an unknown review each say why nothing was suggested", async (t) => {
  const { service, agents } = await withGuide(t);
  const subject = onCode({ kind: "line", path: "src/upload.ts", line: { side: "new", line: 13 } });

  assert.deepEqual(await suggest(service, onCode({ kind: "line", path: "src/upload.ts", line: { side: "new", line: 30 } }), "x"), {
    status: "failed",
    message: "Line 30 of src/upload.ts is not in the diff, so a comment cannot be anchored there.",
  });
  assert.deepEqual(await suggest(service, onCode({ kind: "file", path: "src/other.ts" }), "x"), {
    status: "failed",
    message: "src/other.ts is not one of the change's files.",
  });
  assert.deepEqual(await service.suggestWording({ reviewId: "github/github.com/acme/uploader/8", headSha: HEAD, subject, prompt: "x" }), {
    status: "failed",
    message: "This review is not known here any more. Start it again.",
  });

  let release!: (reply: string) => void;
  const reply = new Promise<string>((resolve) => (release = resolve));
  agents.answer = () => reply;
  await service.generateGuide({ reviewId: REVIEW_ID });
  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt: "x" }), {
    status: "failed",
    message: "The guide agent is still writing the guide. Try again once the guide is ready.",
  });
  while (agents.created.length < 2) await new Promise((resolve) => setImmediate(resolve));
  release(sampleGuideReply());
  await service.settled();

  await agents.archive("agent-2");
  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject, prompt: "x" }), {
    status: "failed",
    message: "The guide agent is gone: it was archived or closed, so there is no one to suggest wording.",
  });
  assert.deepEqual(
    agents.created.map((agent) => agent.sent),
    [[], []],
  );
});

test("a failed guide has no agent to suggest wording", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-wording-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, sampleChangeRequest(URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => "No JSON here.";
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: HEAD, subject: onCode({ kind: "file", path: "src/retry.ts" }), prompt: "" }), {
    status: "failed",
    message: "There is no finished guide yet, so there is no guide agent to suggest wording.",
  });
});
