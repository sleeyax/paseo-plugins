import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fakeForge, sampleChangeRequest } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import type { CommentSubject } from "../shared/contracts.ts";
import type { DraftLocation } from "../shared/drafts.ts";
import type { Guide } from "../shared/guide.ts";
import type { ChangedFile } from "./forge/port.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { GuideAgentError } from "./guide-agent/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * "Ask agent", from a comment box or from "Ask about this", which send the reviewer's own question
 * about what the box is on, driven through the RPC the panel calls, with what reaches the guide agent's chat.
 */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";

/** Beside `sampleChangeRequest`'s files: a test the guide puts in Supporting, and a doc it places nowhere. */
const RETRY_TEST: ChangedFile = { path: "src/retry.test.ts", previousPath: null, status: "added", additions: 20, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+t" };
const RETRY_DOC: ChangedFile = { path: "docs/retry.md", previousPath: null, status: "added", additions: 12, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+d" };

/** `src/upload.ts` with a second hunk, for nodes that cover part of it. */
const UPLOAD_IN_TWO: ChangedFile = {
  path: "src/upload.ts",
  previousPath: null,
  status: "modified",
  additions: 3,
  deletions: 2,
  patch: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,3 +20,4 @@ retry\n x\n-y\n+y1\n+y2\n z",
};

async function withHost(
  t: TestContext,
  { guide = sampleGuide(), upload }: { guide?: Guide; upload?: ChangedFile } = {},
): Promise<{ service: ReviewService; agents: FakeGuideAgents }> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-ask-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  const changeRequest = sampleChangeRequest(URL);
  const files = changeRequest.files.map((file) => (upload !== undefined && file.path === upload.path ? upload : file));
  forge.changeRequests.set(URL, { ...changeRequest, files: [...files, RETRY_TEST, RETRY_DOC] });
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply({ ...guide, supporting: [{ path: RETRY_TEST.path, category: "test" }] });
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  return { service, agents };
}

async function withGuide(t: TestContext, options?: Parameters<typeof withHost>[1]) {
  const host = await withHost(t, options);
  await host.service.start({ url: URL });
  await host.service.settled();
  return host;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}


const HEAD = "b".repeat(40);

function question(service: ReviewService, subject: CommentSubject, text: string, headSha = HEAD, reviewId = REVIEW_ID) {
  return service.askQuestion({ reviewId, headSha, subject, question: text });
}

test("a question on code sends the lines, the node they fall in and the question, and nothing to the forge", async (t) => {
  const { service, agents } = await withGuide(t, { upload: UPLOAD_IN_TWO });

  const location: DraftLocation = { kind: "range", path: "src/upload.ts", start: { side: "new", line: 21 }, end: { side: "new", line: 22 } };
  assert.deepEqual(await question(service, { kind: "code", location }, "  Why two lines?  "), { status: "sent", agentId: "agent-1" });

  const [prompt, ...rest] = agents.created[0]!.sent;
  assert.equal(rest.length, 0);
  assert.equal(
    prompt,
    [
      `The reviewer of ${URL} at bbbbbbbbbbbb has a question for you.`,
      "It is about lines 21–22 of src/upload.ts. The lines as the diff shows them:\n```diff\n+y1\n+y2\n```",
      "Your guide does not place this code in any of its nodes.",
      "Their question:\n```\nWhy two lines?\n```",
      [
        "Answer as a normal message; the reviewer reads it in this chat and will ask follow-up questions here.",
        "- Answer the question they asked. Do not raise bugs, security issues, risks, style problems or fixes they did not ask about.",
        "- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.",
        "- Do not answer with JSON.",
      ].join("\n"),
    ].join("\n\n"),
  );
});

test("a question on a Supporting or Unsorted file as a whole names where the guide put it", async (t) => {
  const { service, agents } = await withGuide(t);
  const onFile = (path: string): CommentSubject => ({ kind: "code", location: { kind: "file", path } });

  assert.equal((await question(service, onFile("src/retry.test.ts"), "What does it test?")).status, "sent");
  assert.equal((await question(service, onFile("docs/retry.md"), "Who reads this?")).status, "sent");
  assert.equal((await question(service, onFile("src/retry.ts"), "Why here?")).status, "sent");

  const [supporting, unsorted, placed] = agents.created[0]!.sent;
  assert.match(supporting!, /\n\nIt is about src\/retry\.test\.ts as a whole\. The file was added, \+20 −0\. Your guide lists it under Supporting, as test\.\n\n/);
  assert.match(
    unsorted!,
    /\n\nIt is about docs\/retry\.md as a whole\. The file was added, \+12 −0\. Your guide did not place it in any node or in its Supporting group; it lists it as Unsorted\.\n\n/,
  );
  assert.match(placed!, /\n\nIt is about src\/retry\.ts as a whole\. The file was added, \+12 −0\.\n\n/);
});

test("a question on a file some nodes cover part of names the lines its entry holds", async (t) => {
  const guide = sampleGuide();
  guide.nodes[1]!.covers = [{ path: "src/upload.ts", hunks: [1], lines: [] }];
  const { service, agents } = await withGuide(t, { guide, upload: UPLOAD_IN_TWO });

  assert.equal((await question(service, { kind: "code", location: { kind: "file", path: "src/upload.ts" } }, "And the rest?")).status, "sent");

  const prompt = agents.created[0]!.sent[0]!;
  assert.match(prompt, /it lists it as Unsorted\. What it lists there is the part no node covers: src\/upload\.ts, lines 20-23\.\n\n/);
  assert.match(prompt, /The node of your guide this code falls in:\n- "uploader", "Uploader uses the policy": /);
});

test("a question on highlighted text of a concept or the overview names it with the passage", async (t) => {
  const { service, agents } = await withGuide(t);

  assert.equal((await question(service, { kind: "node", nodeId: "retry-policy", quote: "pure function" }, "Pure how?")).status, "sent");
  assert.equal((await question(service, { kind: "overview", quote: "transient" }, "Which failures are transient?")).status, "sent");

  const [concept, overview] = agents.created[0]!.sent;
  assert.match(concept!, /\n\nIt is about one concept of the change, the node "retry-policy", "Retry policy" of your guide\.\nWhat the guide says about it:\n/);
  assert.match(concept!, /\n\nThe reviewer highlighted this passage of your guide to ask about:\n```\npure function\n```\n\nTheir question:\n```\nPure how\?\n```\n\n/);
  assert.match(overview!, /\n\nIt is about the overview of your guide, which says:\n- Idea: Uploads that fail/);
  assert.match(overview!, /- Where to spend attention: "Retry policy": Every retry decision is made here\./);
  assert.match(overview!, /passage of your guide to ask about:\n```\ntransient\n```/);
});

test("a question with no text, on a guide Regenerate replaced, or on a concept the guide lost is not sent", async (t) => {
  const { service, agents } = await withGuide(t);
  const node: CommentSubject = { kind: "node", nodeId: "uploader" };

  assert.deepEqual(await question(service, node, "   "), { status: "not-sent", agentId: "agent-1", message: "Type a question to ask first." });
  assert.deepEqual(await question(service, { kind: "node", nodeId: "backoff" }, "Why?"), {
    status: "not-sent",
    agentId: "agent-1",
    message: "That concept is not in the guide any more.",
  });
  assert.deepEqual(await question(service, node, "Why?", "d".repeat(40)), {
    status: "not-sent",
    agentId: null,
    message: "This question is about the guide at ddddddd, which was regenerated for bbbbbbb. Ask from the guide at the new head.",
  });
  agents.created[0]!.status = "busy";
  assert.deepEqual(await question(service, node, "Why?"), {
    status: "not-sent",
    agentId: "agent-1",
    message: "The guide agent is busy with another answer. Ask again once it has finished.",
  });
  assert.deepEqual(agents.created[0]!.sent, []);
});

test("a question on a concept lists the code it covers, with the lines of a file it covers part of", async (t) => {
  const guide = sampleGuide();
  guide.nodes[0]!.covers = [
    { path: "src/retry.ts", hunks: [], lines: [] },
    { path: "src/upload.ts", hunks: [], lines: [{ start: 1, end: 1 }] },
  ];
  guide.nodes[1]!.covers = [{ path: "src/upload.ts", hunks: [2], lines: [] }];
  const { service, agents } = await withGuide(t, { guide, upload: UPLOAD_IN_TWO });

  assert.equal((await question(service, { kind: "node", nodeId: "retry-policy" }, "Why jitter?")).status, "sent");
  assert.equal((await question(service, { kind: "node", nodeId: "uploader" }, "Why here?")).status, "sent");

  const [policy, uploader] = agents.created[0]!.sent;
  assert.equal(
    policy,
    [
      `The reviewer of ${URL} at bbbbbbbbbbbb has a question for you.`,
      [
        'It is about one concept of the change, the node "retry-policy", "Retry policy" of your guide.',
        "What the guide says about it:",
        "- Summary: Decides whether and when a failed upload is tried again.",
        "- Why: Retries happen in one place, so every caller backs off the same way.",
        "- What it does: A pure function from the attempt number and the failure to a delay, or to giving up.",
        "- Decision: Full jitter on the backoff. Rather than: A fixed delay, which makes clients retry in lockstep.",
        "",
        "The code it covers:",
        "- src/retry.ts",
        "- src/upload.ts, line 1",
      ].join("\n"),
      "Their question:\n```\nWhy jitter?\n```",
      [
        "Answer as a normal message; the reviewer reads it in this chat and will ask follow-up questions here.",
        "- Answer the question they asked. Do not raise bugs, security issues, risks, style problems or fixes they did not ask about.",
        "- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.",
        "- Do not answer with JSON.",
      ].join("\n"),
    ].join("\n\n"),
  );
  assert.match(uploader!, /The code it covers:\n- src\/upload\.ts, lines 20-23\n/);
});

test("an agent that turns busy between the check and the send is reported in its own words", async (t) => {
  const { service, agents } = await withGuide(t);
  agents.send = async () => {
    throw new GuideAgentError("The guide agent is still busy. Wait for it to finish, then try again.");
  };

  assert.deepEqual(await question(service, { kind: "node", nodeId: "uploader" }, "Why?"), {
    status: "not-sent",
    agentId: "agent-1",
    message: "The guide agent is still busy. Wait for it to finish, then try again.",
  });
});

test("a guide agent that is gone, a guide still being written, a file the change lacks and an unknown review each say why nothing was sent", async (t) => {
  const { service, agents } = await withGuide(t);
  const node: CommentSubject = { kind: "node", nodeId: "uploader" };

  assert.deepEqual(await question(service, { kind: "code", location: { kind: "file", path: "src/other.ts" } }, "Why?"), {
    status: "not-sent",
    agentId: "agent-1",
    message: "src/other.ts is not one of the change's files.",
  });

  await agents.archive("agent-1");
  assert.deepEqual(await question(service, node, "Why?"), {
    status: "not-sent",
    agentId: null,
    message: "The guide agent is gone: it was archived or closed, so there is no chat to ask in.",
  });

  let release!: (reply: string) => void;
  const reply = new Promise<string>((resolve) => (release = resolve));
  agents.answer = () => reply;
  await service.generateGuide({ reviewId: REVIEW_ID });
  while (agents.created.length < 2) await tick();
  assert.deepEqual(await question(service, node, "Why?"), {
    status: "not-sent",
    agentId: "agent-2",
    message: "The guide agent is still writing the guide. Ask once the guide is ready.",
  });
  release(sampleGuideReply());
  await service.settled();

  assert.deepEqual(await question(service, node, "Why?", HEAD, "github/github.com/acme/uploader/8"), {
    status: "not-sent",
    agentId: null,
    message: "This review is not known here any more. Start it again.",
  });
  assert.deepEqual(
    agents.created.map((agent) => agent.sent),
    [[], []],
  );
});

test("a failed guide has nothing to ask about", async (t) => {
  const { service, agents } = await withHost(t);
  agents.answer = () => "No JSON here.";
  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await question(service, { kind: "node", nodeId: "uploader" }, "Why?"), {
    status: "not-sent",
    agentId: "agent-1",
    message: "There is no finished guide to ask about yet.",
  });
});
