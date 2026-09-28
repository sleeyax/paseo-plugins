import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fakeForge, sampleChangeRequest } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { GuideAgentError } from "./guide-agent/port.ts";
import { ReviewService } from "./review-service.ts";

/** "Ask about this", driven through the RPC the panel calls, with what reaches the guide agent's chat. */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";

async function withHost(t: TestContext): Promise<{ service: ReviewService; agents: FakeGuideAgents }> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-ask-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, sampleChangeRequest(URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply();
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  return { service, agents };
}

async function withGuide(t: TestContext) {
  const host = await withHost(t);
  await host.service.start({ url: URL });
  await host.service.settled();
  return host;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("asking about a node sends the guide agent a prompt naming it, with what the guide says about it", async (t) => {
  const { service, agents } = await withGuide(t);

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "retry-policy" } }), {
    status: "sent",
    agentId: "agent-1",
  });

  const [prompt, ...rest] = agents.created[0]!.sent;
  assert.equal(rest.length, 0);
  assert.equal(
    prompt,
    [
      `The reviewer of ${URL} at bbbbbbbbbbbb wants to understand one concept of your guide better: the node "retry-policy", "Retry policy".`,
      [
        "What the guide says about it:",
        "- Summary: Decides whether and when a failed upload is tried again.",
        "- Explanation: A pure function from the attempt number and the failure to a delay, or to giving up.",
        "- Decision: Full jitter on the backoff. Rather than: A fixed delay, which makes clients retry in lockstep.",
      ].join("\n"),
      "Explain this concept in more depth than the guide does: how it works in the surrounding code, why it was done this way (using the description, the commits and the linked issues), and how the rest of the change relies on it.",
      [
        "Answer as a normal message; the reviewer reads it in this chat and will ask follow-up questions here.",
        "- Explain only. Do not report bugs, security issues, risks or style problems, and do not suggest fixes.",
        "- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.",
        "- Do not answer with JSON.",
      ].join("\n"),
    ].join("\n\n"),
  );
});

test("asking about a changed file outside the nodes names the file, how it changed, and that the guide left it unsorted", async (t) => {
  const { service, agents } = await withGuide(t);

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "file", path: "src/retry.ts" } }), {
    status: "sent",
    agentId: "agent-1",
  });

  const prompt = agents.created[0]!.sent[0]!;
  assert.match(prompt, /wants to understand one changed file your guide kept outside its concepts: src\/retry\.ts\./);
  assert.match(prompt, /The file was added, \+12 −0\. The guide did not place it in any concept or in its Supporting group; it is listed as Unsorted\./);
  assert.match(prompt, /Explain what this file's change does and which part of the change it belongs to\./);
  assert.match(prompt, /- Explain only\./);
});

test("a busy guide agent is not sent to, and the reviewer is told why, with the agent to open", async (t) => {
  const { service, agents } = await withGuide(t);
  agents.created[0]!.status = "busy";

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } }), {
    status: "not-sent",
    agentId: "agent-1",
    message: "The guide agent is busy with another answer. Ask again once it has finished.",
  });
  assert.deepEqual(agents.created[0]!.sent, []);

  agents.created[0]!.status = "idle";
  assert.equal((await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } })).status, "sent");
  assert.equal(agents.created[0]!.sent.length, 1);
});

test("an agent that turns busy between the check and the send is reported in its own words", async (t) => {
  const { service, agents } = await withGuide(t);
  agents.send = async () => {
    throw new GuideAgentError("The guide agent is still busy. Wait for it to finish, then try again.");
  };

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } }), {
    status: "not-sent",
    agentId: "agent-1",
    message: "The guide agent is still busy. Wait for it to finish, then try again.",
  });
});

test("a guide agent that is gone, a guide still being written, and an unknown subject each say why nothing was sent", async (t) => {
  const { service, agents } = await withGuide(t);

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "backoff" } }), {
    status: "not-sent",
    agentId: "agent-1",
    message: "That concept is not in the guide any more.",
  });
  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "file", path: "src/other.ts" } }), {
    status: "not-sent",
    agentId: "agent-1",
    message: "src/other.ts is not one of the change's files.",
  });

  await agents.archive("agent-1");
  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } }), {
    status: "not-sent",
    agentId: null,
    message: "The guide agent is gone: it was archived or closed. Generate the guide again to ask about it.",
  });

  let release!: (reply: string) => void;
  const reply = new Promise<string>((resolve) => (release = resolve));
  agents.answer = () => reply;
  await service.generateGuide({ reviewId: REVIEW_ID });
  while (agents.created.length < 2) await tick();
  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } }), {
    status: "not-sent",
    agentId: "agent-2",
    message: "The guide agent is still writing the guide. Ask once the guide is ready.",
  });
  release(sampleGuideReply());
  await service.settled();

  assert.deepEqual(await service.ask({ reviewId: "github/github.com/acme/uploader/8", subject: { kind: "node", nodeId: "uploader" } }), {
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

  assert.deepEqual(await service.ask({ reviewId: REVIEW_ID, subject: { kind: "node", nodeId: "uploader" } }), {
    status: "not-sent",
    agentId: "agent-1",
    message: "There is no finished guide to ask about yet.",
  });
});
