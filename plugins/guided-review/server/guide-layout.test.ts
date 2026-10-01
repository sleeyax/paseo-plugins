import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { coveredPaths, type CoveredCode, type Guide, type GuideNode } from "../shared/guide.ts";
import { fakeForge, sampleChangeRequest } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import type { ChangedFile } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * How the service lays the agent's guide out for the panel: layers from the dependencies, the edges
 * it turns down, the files it sets aside before generation, and the files the agent left unplaced.
 */

const URL = "https://github.com/acme/uploader/pull/7";
const WORKSPACE_ID = "wks_0000000000000001";

async function withHost(t: TestContext, files?: ChangedFile[]): Promise<{ service: ReviewService; agents: FakeGuideAgents }> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-layout-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, sampleChangeRequest(URL, files ? { files } : {}));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  return { service: new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data }), agents };
}

async function generated(service: ReviewService, agents: FakeGuideAgents, guide: Guide) {
  agents.answer = () => sampleGuideReply(guide);
  await service.start({ url: URL });
  await service.settled();
  const panel = await service.panel({ workspaceId: WORKSPACE_ID });
  assert.equal(panel.status, "ready");
  return panel.status === "ready" ? panel.guide : null;
}

function file(filePath: string, patch = "@@ -1,1 +1,1 @@\n-a\n+b"): ChangedFile {
  return { path: filePath, previousPath: null, status: "modified", additions: 1, deletions: 1, patch };
}

/** A node covering `covers`, where a bare path covers the whole file. */
function node(id: string, covers: (string | CoveredCode)[], dependsOn: string[] = []): GuideNode {
  return {
    id,
    title: `The ${id}`,
    summary: `What ${id} does.`,
    explanation: `How ${id} works.`,
    covers: covers.map((cover) => (typeof cover === "string" ? { path: cover, hunks: [], lines: [] } : cover)),
    decisions: [],
    dependencies: dependsOn.map((nodeId) => ({ nodeId, reason: `${id} builds on ${nodeId}.` })),
  };
}

function guideOf(nodes: GuideNode[], supporting: Guide["supporting"] = []): Guide {
  return { ...sampleGuide(), overview: { ...sampleGuide().overview, attention: [{ nodeId: nodes[0]!.id, reason: "It matters." }] }, nodes, supporting };
}

test("nodes are laid out in layers from their dependencies, capped at three, with leaves marked", async (t) => {
  const { service, agents } = await withHost(t, ["a", "b", "c", "d", "e", "f"].map((name) => file(`src/${name}.ts`)));

  const guide = await generated(
    service,
    agents,
    guideOf([
      node("store", ["src/a.ts"]),
      node("config", ["src/e.ts"]),
      node("cache", ["src/b.ts"], ["store"]),
      node("api", ["src/c.ts"], ["cache", "config"]),
      node("handler", ["src/d.ts"], ["api"]),
      node("cli", ["src/f.ts"], ["store"]),
    ]),
  );

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(
    guide.guide.nodes.map(({ id, layer, leaf }) => ({ id, layer, leaf })),
    [
      { id: "store", layer: 0, leaf: false },
      { id: "config", layer: 0, leaf: false },
      { id: "cache", layer: 1, leaf: false },
      { id: "api", layer: 2, leaf: false },
      // Deeper than three layers stays in the last one, after the node it builds on.
      { id: "handler", layer: 2, leaf: true },
      { id: "cli", layer: 1, leaf: true },
    ],
  );
  assert.deepEqual(guide.guide.nodes[3]!.dependencies, [
    { nodeId: "cache", reason: "api builds on cache." },
    { nodeId: "config", reason: "api builds on config." },
  ]);
  assert.deepEqual(guide.guide.unsorted, []);
});

test("a dependency on an unknown node, a later node, or the node itself fails the guide, so no cycle gets through", async (t) => {
  const { service, agents } = await withHost(t);

  const guide = await generated(
    service,
    agents,
    guideOf([node("policy", ["src/retry.ts"], ["uploader", "policy"]), node("uploader", ["src/upload.ts"], ["policy", "backoff"])]),
  );

  assert.deepEqual(guide, {
    status: "failed",
    agentId: "agent-1",
    message:
      "The guide agent's answer did not match what was asked for: " +
      'nodes.0.dependencies.0.nodeId: "uploader" comes after "policy", and a node builds only on nodes listed before it; ' +
      'nodes.0.dependencies.1.nodeId: "policy" cannot build on itself; ' +
      'nodes.1.dependencies.1.nodeId: no node is "backoff".',
  });
});

test("lockfiles and generated files are never shown to the agent and go straight into Supporting", async (t) => {
  const { service, agents } = await withHost(t, [
    file("src/upload.ts"),
    file("pnpm-lock.yaml"),
    file("src/retry.ts"),
    file("web/dist/app.min.js"),
    file("api/__generated__/schema.ts"),
    file("rust/Cargo.lock"),
    file("proto/upload.pb.go"),
  ]);

  // The agent names a lockfile anyway: it stays where the paths put it, once.
  const guide = await generated(service, agents, {
    ...sampleGuide(),
    supporting: [{ path: "pnpm-lock.yaml", category: "wiring" }],
  });

  const prompt = agents.created[0]!.prompt;
  for (const hidden of ["pnpm-lock.yaml", "app.min.js", "__generated__", "Cargo.lock", "upload.pb.go"]) {
    assert.ok(!prompt.includes(hidden), `the prompt mentions ${hidden}`);
  }
  assert.match(prompt, /- src\/retry\.ts \(modified, \+1 −1\)\n\(5 lockfile or generated files are left out: they are placed already\.\)/);

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(guide.guide.supporting, [
    { path: "pnpm-lock.yaml", category: "lockfile" },
    { path: "web/dist/app.min.js", category: "generated" },
    { path: "api/__generated__/schema.ts", category: "generated" },
    { path: "rust/Cargo.lock", category: "lockfile" },
    { path: "proto/upload.pb.go", category: "generated" },
  ]);
  assert.deepEqual(guide.guide.unsorted, []);
});

test("a file its nodes cover between them is placed, several nodes may share one, and the rest go to Unsorted without a retry", async (t) => {
  const { service, agents } = await withHost(t, [
    file("src/upload.ts"),
    file("src/retry.ts"),
    file("src/retry.test.ts"),
    file("README.md"),
    file("src/index.ts"),
    file("src/clock.ts", "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d"),
  ]);

  const guide = await generated(
    service,
    agents,
    guideOf(
      [
        node("retry-policy", ["./src/retry.ts", { path: "src/clock.ts", hunks: [1], lines: [] }]),
        node("uploader", [{ path: "src/upload.ts", hunks: [1], lines: [] }, { path: "src/clock.ts", hunks: [2], lines: [] }], ["retry-policy"]),
      ],
      [
        { path: "src/retry.test.ts", category: "test" },
        // A node covers it already, so Supporting does not list it again.
        { path: "src/upload.ts", category: "wiring" },
        { path: "src/retry.test.ts", category: "test" },
      ],
    ),
  );

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(
    guide.guide.nodes.map((entry) => ({ id: entry.id, files: coveredPaths(entry) })),
    [
      { id: "retry-policy", files: ["src/retry.ts", "src/clock.ts"] },
      { id: "uploader", files: ["src/upload.ts", "src/clock.ts"] },
    ],
  );
  assert.deepEqual(guide.guide.supporting, [{ path: "src/retry.test.ts", category: "test" }]);
  assert.deepEqual(guide.guide.unsorted, ["README.md", "src/index.ts"]);
  assert.equal(agents.created.length, 1);
  assert.deepEqual(agents.created[0]!.sent, []);
});

test("a file some node covers part of keeps the rest in its Supporting entry, or else in Unsorted", async (t) => {
  const twoHunks = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d";
  const { service, agents } = await withHost(t, [
    file("src/upload.ts", twoHunks),
    file("src/retry.ts", twoHunks),
    file("src/wire.ts", twoHunks),
    file("src/clock.ts", "@@ -1,3 +1,3 @@\n x\n-a\n+b\n y"),
  ]);

  const guide = await generated(
    service,
    agents,
    guideOf(
      [
        node("uploader", [{ path: "src/upload.ts", hunks: [1], lines: [] }]),
        // A range over one hunk's lines leaves the other hunk's change.
        node("policy", [{ path: "src/retry.ts", hunks: [], lines: [{ start: 1, end: 1 }] }]),
        node("wiring", [{ path: "src/wire.ts", hunks: [1, 2], lines: [] }]),
        // What a range leaves of a hunk is only context, so nothing of the file is left.
        node("clock", [{ path: "src/clock.ts", hunks: [], lines: [{ start: 2, end: 2 }] }]),
      ],
      [
        // The rest of a partly covered file stays where the agent put it.
        { path: "src/upload.ts", category: "wiring" },
        // Nothing is left of a file its nodes cover whole.
        { path: "src/wire.ts", category: "wiring" },
      ],
    ),
  );

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(guide.guide.supporting, [{ path: "src/upload.ts", category: "wiring" }]);
  assert.deepEqual(guide.guide.unsorted, ["src/retry.ts"]);
});

test("a file whose ranges leave only blank lines uncovered is placed, and one with more left over is not", async (t) => {
  const blocks = "@@ -0,0 +1,5 @@\n+a\n+\n+b\n+\n+c";
  const { service, agents } = await withHost(t, [file("src/blocks.ts", blocks), file("src/more.ts", blocks)]);

  const guide = await generated(
    service,
    agents,
    guideOf([
      node("blocks", [
        { path: "src/blocks.ts", hunks: [], lines: [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }] },
        { path: "src/more.ts", hunks: [], lines: [{ start: 1, end: 1 }] },
      ]),
    ]),
  );

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(guide.guide.unsorted, ["src/more.ts"]);
});

test("a decision keeps its alternative only when the author's words quoted for it are in the change request or the diff", async (t) => {
  const { service, agents } = await withHost(t, [file("src/a.ts", "@@ -1,1 +1,1 @@\n-a\n+// Polling, not a webhook: the webhook drops events under load.")]);
  const decision = (quote: string) => ({ choice: "Poll.", alternative: { text: "A webhook, which drops events.", quote } });

  const guide = await generated(service, agents, {
    ...guideOf([node("a", ["src/a.ts"])]),
    overview: {
      ...guideOf([node("a", ["src/a.ts"])]).overview,
      decisions: [
        // The commit message, quoted with curly quotes and Markdown the text does not have.
        decision("“a *fixed* delay would make clients retry in lockstep.”"),
        // An added line of the diff.
        decision("the webhook drops events under load"),
        decision("webhooks are too expensive to run"),
        // Too short to back anything, though it is in the description.
        decision("retried with"),
        { choice: "Retry.", alternative: null },
      ],
    },
  });

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(
    guide.guide.overview.decisions.map((entry) => entry.alternative !== null),
    [true, true, false, false, false],
  );
});

test("a node keeps only the decisions whose quoted alternative the overview does not already give", async (t) => {
  const { service, agents } = await withHost(t, [file("src/a.ts", "@@ -1,1 +1,1 @@\n-a\n+// Polling, not a webhook: the webhook drops events under load.")]);
  const decision = (choice: string, quote: string) => ({ choice, alternative: { text: "Not that.", quote } });
  const base = guideOf([node("a", ["src/a.ts"])]);

  const guide = await generated(service, agents, {
    ...base,
    overview: { ...base.overview, decisions: [decision("Poll.", "the webhook drops events under load")] },
    nodes: [
      {
        ...base.nodes[0]!,
        decisions: [
          decision("Jitter.", "a fixed delay would make clients retry in lockstep"),
          decision("Poll here too.", "“The webhook drops events under load.”"),
          decision("Cache.", "caching is out of scope here"),
          { choice: "Retry.", alternative: null },
        ],
      },
    ],
  });

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(guide.guide.nodes[0]!.decisions.map((entry) => entry.choice), ["Jitter."]);
  assert.notEqual(guide.guide.overview.decisions[0]!.alternative, null);
});

test("a lockfile a node covers stays in Supporting, where the paths put it, and leaves the node", async (t) => {
  const { service, agents } = await withHost(t, [file("src/upload.ts"), file("src/retry.ts"), file("pnpm-lock.yaml")]);

  const guide = await generated(service, agents, {
    ...sampleGuide(),
    nodes: [sampleGuide().nodes[0]!, { ...sampleGuide().nodes[1]!, covers: [...sampleGuide().nodes[1]!.covers, { path: "./pnpm-lock.yaml", hunks: [7], lines: [] }] }],
  });

  assert.equal(guide?.status, "ready");
  if (guide?.status !== "ready") return;
  assert.deepEqual(guide.guide.supporting, [{ path: "pnpm-lock.yaml", category: "lockfile" }]);
  assert.deepEqual(guide.guide.unsorted, []);
  // The agent never saw it, so its hunk 7 is not checked, and no node shows it a second time.
  assert.deepEqual(guide.guide.nodes[1]!.covers, [{ path: "src/upload.ts", hunks: [1], lines: [] }]);
});

test("a node that covers only lockfiles or generated files fails the guide", async (t) => {
  const { service, agents } = await withHost(t, [file("src/upload.ts"), file("src/retry.ts"), file("pnpm-lock.yaml")]);

  const guide = await generated(service, agents, guideOf([node("policy", ["src/retry.ts", "src/upload.ts"]), node("deps", ["pnpm-lock.yaml"])]));

  assert.deepEqual(guide, {
    status: "failed",
    agentId: "agent-1",
    message: "The guide agent's answer did not match what was asked for: nodes.1.covers: it names only lockfiles or generated files, which are placed already.",
  });
});

test("a node covering a path the change does not have fails the guide", async (t) => {
  const { service, agents } = await withHost(t);

  const guide = await generated(service, agents, guideOf([node("policy", ["src/retry.ts", "src/missing.ts"]), node("uploader", ["src/upload.ts"])]));

  assert.deepEqual(guide, {
    status: "failed",
    agentId: "agent-1",
    message: 'The guide agent\'s answer did not match what was asked for: nodes.0.covers.1.path: "src/missing.ts" is not one of the changed files.',
  });
});
