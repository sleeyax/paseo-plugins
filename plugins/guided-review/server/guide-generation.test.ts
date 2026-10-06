import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, sampleLayeredGuide, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces, type FakeWorkspaces } from "./fake-workspaces.ts";
import { GuideAgentError } from "./guide-agent/port.ts";
import { ReviewService } from "./review-service.ts";

/** The review service's guide generation, driven through the RPCs the start surface and the panel call. */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";
const WORKSPACE_ID = "wks_0000000000000001";
const HEAD = "b".repeat(40);

type Host = {
  data: string;
  forge: FakeForge;
  workspaces: FakeWorkspaces;
  agents: FakeGuideAgents;
  service: ReviewService;
  /** A second service over the same data directory, as after a plugin restart. */
  restart(): ReviewService;
};

async function withHost(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-guide-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, sampleChangeRequest(URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply();
  const create = () => new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  return { data, forge, workspaces, agents, service: create(), restart: create };
}

/** A reply the test hands the agent when it chooses, to look at the panel while the agent works. */
function held() {
  let release!: (reply: string | Error) => void;
  const reply = new Promise<string | Error>((resolve) => {
    release = resolve;
  });
  return { reply, release };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const GUIDE_FILE = path.join("reviews", "github", "github.com", "acme", "uploader", "7", "guides", `${HEAD}.json`);

/** The guide record on disk, or null before there is one. */
async function storedGuide(data: string): Promise<{ agentId: string | null; guide: unknown } | null> {
  try {
    return JSON.parse(await readFile(path.join(data, GUIDE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function guideOf(service: ReviewService, workspaceId = WORKSPACE_ID) {
  const panel = await service.panel({ workspaceId });
  assert.equal(panel.status, "ready");
  return panel.status === "ready" ? panel.guide : null;
}

test("a started review has a read-only guide agent in its workspace write the guide, which the panel then shows", async (t) => {
  const { service, agents } = await withHost(t);

  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await guideOf(service), { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() });
  assert.equal(agents.created.length, 1);
  const [agent] = agents.created;
  assert.deepEqual(agent!.workspace, { id: WORKSPACE_ID, directory: "/home/r/src/uploader-worktrees/pr-7" });
  assert.equal(agent!.title, "Guide: Retry failed uploads");
  assert.deepEqual(agent!.labels, { "guided-review.review": REVIEW_ID, "guided-review.head": HEAD });
  assert.equal((agent!.outputSchema as { type?: string }).type, "object");
});

test("the generation prompt carries the change, forbids findings, and ends with the guide's schema", async (t) => {
  const { service, agents } = await withHost(t);

  await service.start({ url: URL });
  await service.settled();

  const prompt = agents.created[0]!.prompt;
  assert.match(prompt, /Write a guide to https:\/\/github\.com\/acme\/uploader\/pull\/7/);
  assert.match(prompt, /Explain only\. Do not report bugs, security issues, risks or style problems, and do not suggest fixes/);
  assert.match(prompt, /Do not edit or write files, and do not run commands\./);
  assert.match(prompt, /Uploads that fail on a flaky network are retried with backoff\./);
  assert.match(prompt, /- c{7} Retry uploads/);
  assert.match(prompt, /- #12 Uploads fail \(open\)/);
  assert.match(prompt, /- src\/retry\.ts \(added, \+12 −0\)/);
  assert.match(prompt, /### src\/upload\.ts\n\nHunk 1:\n\n```diff\n@@ -1,1 \+1,1 @@\n-a\n\+b\n```/);
  assert.match(prompt, /A node's `covers` names the code it explains/);
  assert.match(prompt, /"covers"/);
  assert.match(prompt, /Respond with JSON only that matches this JSON Schema, as your final message:\n\{\n/);
  assert.match(prompt, /"needToKnows"/);
  assert.ok(prompt.endsWith("}"));
});

test("while the agent writes, the panel says so and links the agent, and follows it to the finished guide", async (t) => {
  const { service, agents } = await withHost(t);
  const { reply, release } = held();
  agents.answer = () => reply;

  await service.start({ url: URL });
  // The start job ends once the workspace is ready; the guide is a job of its own.
  while (agents.created.length === 0) await tick();

  assert.equal((await service.startProgress({ reviewId: REVIEW_ID })).phase, "ready");
  assert.deepEqual(await guideOf(service), { status: "generating", agentId: "agent-1" });

  release(sampleGuideReply());
  await service.settled();
  assert.deepEqual(await guideOf(service), { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() });
});

test("output that does not fit the schema fails the guide with a reason, and a retry asks a new agent", async (t) => {
  const { service, agents } = await withHost(t);
  const broken = sampleGuide() as unknown as { overview: Record<string, unknown> };
  delete broken.overview.idea;
  agents.answer = () => sampleGuideReply(broken);

  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await guideOf(service), {
    status: "failed",
    agentId: "agent-1",
    message: "The guide agent's answer did not match what was asked for: overview.idea: Invalid input: expected string, received undefined.",
  });

  agents.answer = () => sampleGuideReply();
  assert.deepEqual(await service.generateGuide({ reviewId: REVIEW_ID }), { status: "generating", agentId: null });
  await service.settled();

  assert.deepEqual(await guideOf(service), { status: "ready", agentId: "agent-2", guide: sampleLayeredGuide() });
  assert.deepEqual(agents.archived, ["agent-1"]);
});

test("a guide that points at nodes it does not have, or names two nodes alike, is invalid", async (t) => {
  const { service, agents } = await withHost(t);
  const guide = sampleGuide();
  guide.nodes[1]!.id = "retry-policy";
  guide.nodes[1]!.dependencies = [];
  guide.overview.attention = [{ nodeId: "backoff", reason: "It matters." }];
  agents.answer = () => sampleGuideReply(guide);

  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await guideOf(service), {
    status: "failed",
    agentId: "agent-1",
    message:
      'The guide agent\'s answer did not match what was asked for: nodes.1.id: "retry-policy" is used by an earlier node; overview.attention.0.nodeId: no node is "backoff".',
  });
});

test("a guide whose nodes name code the change does not have is invalid", async (t) => {
  const { service, agents } = await withHost(t);
  const guide = sampleGuide();
  guide.nodes[0]!.covers = [{ path: "src/retry.test.ts", hunks: [], lines: [] }];
  guide.nodes[1]!.covers = [{ path: "src/upload.ts", hunks: [2], lines: [{ start: 40, end: 50 }] }];
  agents.answer = () => sampleGuideReply(guide);

  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(await guideOf(service), {
    status: "failed",
    agentId: "agent-1",
    message:
      'The guide agent\'s answer did not match what was asked for: nodes.0.covers.0.path: "src/retry.test.ts" is not one of the changed files; nodes.1.covers.0.hunks.0: src/upload.ts has 1 hunk, so no hunk 2; nodes.1.covers.0.lines.0: lines 40–50 are not in the diff of src/upload.ts.',
  });
});

test("a node that names only a file's path covers all of it", async (t) => {
  const { service, agents } = await withHost(t);
  const guide = sampleGuide() as unknown as { nodes: { covers: unknown }[] };
  guide.nodes[1]!.covers = [{ path: "src/upload.ts" }];
  agents.answer = () => sampleGuideReply(guide);

  await service.start({ url: URL });
  await service.settled();

  const expected = sampleLayeredGuide();
  expected.nodes[1]!.covers = [{ path: "src/upload.ts", hunks: [], lines: [] }];
  assert.deepEqual(await guideOf(service), { status: "ready", agentId: "agent-1", guide: expected });
});

test("a file whose diff the forge withheld is covered whole, whatever lines the agent read in the checkout", async (t) => {
  const { service, forge, agents } = await withHost(t);
  const files = sampleChangeRequest(URL).files.map((file) => (file.path === "src/retry.ts" ? { ...file, additions: 0, patch: null } : file));
  forge.changeRequests.set(URL, sampleChangeRequest(URL, { files }));
  const guide = sampleGuide();
  guide.nodes[0]!.covers = [{ path: "src/retry.ts", hunks: [3], lines: [{ start: 233, end: 257 }] }];
  agents.answer = () => sampleGuideReply(guide);

  await service.start({ url: URL });
  await service.settled();

  assert.match(agents.created[0]!.prompt, /### src\/retry\.ts\n\n\(No diff: .* cover it whole: leave `hunks` and `lines` empty/);
  const shown = await guideOf(service);
  assert.equal(shown?.status, "ready");
  assert.deepEqual(shown?.status === "ready" ? shown.guide.nodes[0]!.covers : null, [{ path: "src/retry.ts", hunks: [], lines: [] }]);
});

test("a diff too large for the prompt is still listed by its numbered hunks, for nodes to name", async (t) => {
  const { service, forge, agents } = await withHost(t);
  const long = Array.from({ length: 5_000 }, (_, index) => `+line ${index}`).join("\n");
  forge.changeRequests.set(
    URL,
    sampleChangeRequest(URL, {
      files: [
        { path: "src/upload.ts", previousPath: null, status: "modified", additions: 30, deletions: 7, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
        { path: "src/retry.ts", previousPath: null, status: "added", additions: 12, deletions: 0, patch: `@@ -0,0 +1,5000 @@ intro\n${long}` },
      ],
    }),
  );

  await service.start({ url: URL });
  await service.settled();

  assert.match(
    agents.created[0]!.prompt,
    /### src\/retry\.ts\n\n\(The diff is too large to include here\. Read the file in the repository\. Its hunks:\)\n- Hunk 1: @@ -0,0 \+1,5000 @@ intro\n/,
  );
  assert.doesNotMatch(agents.created[0]!.prompt, /\+line 4999/);
});

test("a reply with no JSON, an agent that fails, and one that cannot be created each fail the guide with a reason", async (t) => {
  const { service, agents } = await withHost(t);

  agents.answer = () => "I could not finish reading the change.";
  await service.start({ url: URL });
  await service.settled();
  assert.deepEqual(await guideOf(service), {
    status: "failed",
    agentId: "agent-1",
    message: "The guide agent's answer did not match what was asked for: the reply holds no JSON.",
  });

  agents.answer = () => new GuideAgentError("The guide agent failed: Provider crashed");
  await service.generateGuide({ reviewId: REVIEW_ID });
  await service.settled();
  assert.deepEqual(await guideOf(service), { status: "failed", agentId: "agent-2", message: "The guide agent failed: Provider crashed" });

  agents.failCreate = new GuideAgentError("The claude provider offers no model for the guide agent. Check the guide agent setting.");
  await service.generateGuide({ reviewId: REVIEW_ID });
  await service.settled();
  assert.deepEqual(await guideOf(service), {
    status: "failed",
    agentId: null,
    message: "The claude provider offers no model for the guide agent. Check the guide agent setting.",
  });
});

test("a retry while the guide is being written follows the running generation", async (t) => {
  const { service, agents } = await withHost(t);
  const { reply, release } = held();
  agents.answer = () => reply;

  await service.start({ url: URL });
  while (agents.created.length === 0) await tick();

  assert.deepEqual(await service.generateGuide({ reviewId: REVIEW_ID }), { status: "generating", agentId: "agent-1" });
  assert.deepEqual(await Promise.all([guideOf(service), guideOf(service)]), [
    { status: "generating", agentId: "agent-1" },
    { status: "generating", agentId: "agent-1" },
  ]);
  release(sampleGuideReply());
  await service.settled();
  assert.equal(agents.created.length, 1);
});

test("reopening the panel, after a restart too, reads the stored guide rather than generating it again", async (t) => {
  const { service, restart, agents, data } = await withHost(t);

  await service.start({ url: URL });
  await service.settled();
  const restarted = restart();

  assert.deepEqual(await guideOf(restarted), { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() });
  await restarted.settled();
  assert.equal(agents.created.length, 1);
  assert.deepEqual((await storedGuide(data))?.guide, sampleLayeredGuide());
});

test("a generation a restart cut off is picked up from its agent, not started over", async (t) => {
  const { service, restart, agents, data } = await withHost(t);
  const { reply } = held();
  agents.answer = () => reply;

  await service.start({ url: URL });
  // The job records the agent as soon as it exists; the "restart" comes after that.
  while ((await storedGuide(data))?.agentId !== "agent-1") await tick();

  agents.answer = () => sampleGuideReply();
  const restarted = restart();
  assert.deepEqual(await guideOf(restarted), { status: "generating", agentId: "agent-1" });
  await restarted.settled();

  assert.deepEqual(await guideOf(restarted), { status: "ready", agentId: "agent-1", guide: sampleLayeredGuide() });
  assert.equal(agents.created.length, 1);
});

test("archiving the workspace archives its guide agent, and starting again gives the new workspace a new guide", async (t) => {
  const { service, workspaces, agents } = await withHost(t);

  await service.start({ url: URL });
  await service.settled();
  workspaces.archive(WORKSPACE_ID);
  await service.workspaceArchived({ workspaceId: WORKSPACE_ID });
  assert.deepEqual(agents.archived, ["agent-1"]);

  await service.start({ url: URL });
  await service.settled();
  assert.deepEqual(await guideOf(service, "wks_0000000000000002"), { status: "ready", agentId: "agent-2", guide: sampleLayeredGuide() });
  assert.equal(agents.created[1]!.workspace.id, "wks_0000000000000002");
});

test("a workspace archived while the plugin was not listening still has its guide agent archived on the next start", async (t) => {
  const { service, workspaces, agents } = await withHost(t);

  await service.start({ url: URL });
  await service.settled();
  workspaces.archive(WORKSPACE_ID);
  await service.start({ url: URL });
  await service.settled();

  assert.deepEqual(agents.archived, ["agent-1"]);
});
