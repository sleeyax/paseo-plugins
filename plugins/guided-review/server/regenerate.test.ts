import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { GuideSubject, StartProgress } from "../shared/contracts.ts";
import type { Guide } from "../shared/guide.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces, type FakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError, type ChangedFile, type ChangeRequest } from "./forge/port.ts";
import { GUIDE_HEAD_LABEL } from "./guide-agent/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * "PR updated since this guide": noticing a push, regenerating the guide for the new head from the
 * panel, and the reviewer's marks carried over to what did not change. Driven through the RPCs.
 */

const URL = "https://github.com/acme/uploader/pull/7";
const REVIEW_ID = "github/github.com/acme/uploader/7";
const OLD = "b".repeat(40);
const NEW = "d".repeat(40);
const PR_WORKSPACE = "wks_0000000000000001";

const RETRY_TEST: ChangedFile = { path: "src/retry.test.ts", previousPath: null, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+t" };
const RETRY_DOC: ChangedFile = { path: "docs/retry.md", previousPath: null, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+d" };

/** The PR at its first head: `sampleChangeRequest`'s two files, a test in Supporting and a doc in Unsorted. */
function atOldHead(): ChangeRequest {
  const changeRequest = sampleChangeRequest(URL);
  return { ...changeRequest, files: [...changeRequest.files, RETRY_TEST, RETRY_DOC] };
}

/**
 * The PR after a push: a hunk added above the uploader's, which renumbers it without changing it, a
 * new retry policy, the test as it was and the doc rewritten.
 */
function atNewHead(): ChangeRequest {
  return sampleChangeRequest(URL, {
    headSha: NEW,
    files: [
      { path: "src/upload.ts", previousPath: null, status: "modified", additions: 3, deletions: 1, patch: "@@ -0,0 +1,2 @@\n+log\n+log\n@@ -1,1 +3,1 @@\n-a\n+b" },
      { path: "src/retry.ts", previousPath: null, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+c2" },
      RETRY_TEST,
      { ...RETRY_DOC, patch: "@@ -0,0 +1,1 @@\n+d2" },
    ],
  });
}

const OLD_GUIDE: Guide = { ...sampleGuide(), supporting: [{ path: RETRY_TEST.path, category: "test" }] };

/** The guide at the new head, with IDs of its own: the uploader's old hunk is now hunk 2, and a node of its own covers the new one. */
function newGuide(): Guide {
  const [policy, uploader] = sampleGuide().nodes as [Guide["nodes"][number], Guide["nodes"][number]];
  return {
    ...OLD_GUIDE,
    overview: { ...OLD_GUIDE.overview, attention: [{ nodeId: "policy", reason: "Every retry decision is made here." }] },
    nodes: [
      { ...policy, id: "policy" },
      { ...uploader, id: "upload-loop", covers: [{ path: "src/upload.ts", hunks: [2], lines: [] }], dependencies: [{ nodeId: "policy", reason: "It asks the policy." }] },
      { ...uploader, id: "logging", title: "Logging", covers: [{ path: "src/upload.ts", hunks: [1], lines: [] }], dependencies: [] },
    ],
  };
}

type Host = {
  data: string;
  forge: FakeForge;
  workspaces: FakeWorkspaces;
  agents: FakeGuideAgents;
  service: ReviewService;
  restart(): ReviewService;
};

/** A review of `oldHead` with `oldGuide` written for it; a guide agent created at `NEW` writes `nextGuide`. */
async function withGuide(
  t: TestContext,
  { oldHead = atOldHead(), oldGuide = OLD_GUIDE, nextGuide = newGuide() }: { oldHead?: ChangeRequest; oldGuide?: Guide; nextGuide?: Guide } = {},
): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-regenerate-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, oldHead);
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  const agents = fakeGuideAgents();
  agents.answer = (agent) => sampleGuideReply(agent.labels[GUIDE_HEAD_LABEL] === NEW ? nextGuide : oldGuide);
  const create = () => new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  const service = create();
  await service.start({ url: URL });
  await service.settled();
  return { data, forge, workspaces, agents, service, restart: create };
}

/** Regenerates the guide the way the panel does, and follows the job to its end. */
async function regenerate(service: ReviewService): Promise<StartProgress> {
  const started = await service.regenerate({ reviewId: REVIEW_ID });
  assert.equal(started.status, "started");
  await service.settled();
  return service.startProgress({ reviewId: REVIEW_ID });
}

function node(nodeId: string) {
  return { kind: "node", nodeId } as const;
}

function mark(service: ReviewService, subject: GuideSubject, headSha = OLD) {
  return service.setUnderstood({ reviewId: REVIEW_ID, headSha, subjects: [subject], understood: true });
}

test("a guide at the forge's head has not moved", async (t) => {
  const { service } = await withGuide(t);

  assert.deepEqual(await service.checkHead({ reviewId: REVIEW_ID }), {
    guideHeadSha: OLD,
    forgeHeadSha: OLD,
    moved: false,
    newCommits: null,
    rewritten: false,
    state: "open",
    message: null,
  });
});

test("a push shows as moved, and nothing is regenerated or moved until Regenerate", async (t) => {
  const { service, forge, workspaces, agents } = await withGuide(t);
  forge.changeRequests.set(URL, { ...atNewHead(), state: "closed" });
  forge.commitsSinceAnswer = { kind: "after", count: 3 };

  assert.deepEqual(await service.checkHead({ reviewId: REVIEW_ID }), {
    guideHeadSha: OLD,
    forgeHeadSha: NEW,
    moved: true,
    newCommits: 3,
    rewritten: false,
    state: "closed",
    message: null,
  });
  // Checked on open and again while open: the panel still shows the guide it had.
  await service.checkHead({ reviewId: REVIEW_ID });
  await service.settled();
  const panel = await service.panel({ workspaceId: PR_WORKSPACE });
  assert.equal(panel.status === "ready" && panel.header.headSha, OLD);
  assert.equal(panel.status === "ready" && panel.guide.status, "ready");
  assert.equal(agents.created.length, 1);
  assert.deepEqual(workspaces.fastForwards, []);
  assert.equal(forge.headReads, 2, "only the head is read, not the whole PR");
});

test("a head the guide's is no longer among the commits of reads as rewritten, and a count the forge cannot give is left out", async (t) => {
  const { service, forge } = await withGuide(t);
  forge.changeRequests.set(URL, atNewHead());

  forge.commitsSinceAnswer = { kind: "rewritten" };
  const rewritten = await service.checkHead({ reviewId: REVIEW_ID });
  assert.deepEqual([rewritten.moved, rewritten.newCommits, rewritten.rewritten], [true, null, true]);

  forge.failCommitsSince = new ForgeError("gh failed: HTTP 502");
  const uncounted = await service.checkHead({ reviewId: REVIEW_ID });
  assert.deepEqual([uncounted.moved, uncounted.newCommits, uncounted.rewritten, uncounted.message], [true, null, false, null]);
});

test("a forge that cannot be asked is reported and reads as not moved", async (t) => {
  const { service, forge } = await withGuide(t);
  forge.failFetchHead = new ForgeError("gh failed: HTTP 502");

  assert.deepEqual(await service.checkHead({ reviewId: REVIEW_ID }), {
    guideHeadSha: OLD,
    forgeHeadSha: null,
    moved: false,
    newCommits: null,
    rewritten: false,
    state: null,
    message: `Could not check ${URL} for new commits: gh failed: HTTP 502`,
  });
  await assert.rejects(service.checkHead({ reviewId: "github/github.com/acme/uploader/8" }), {
    message: "This review is not known here any more. Start it again.",
  });
});

test("Regenerate brings the PR workspace to the new head and switches the panel to a guide keyed by it", async (t) => {
  const { service, forge, workspaces, agents, data } = await withGuide(t);
  forge.changeRequests.set(URL, atNewHead());

  const progress = await regenerate(service);

  assert.deepEqual(
    { phase: progress.phase, workspaceId: progress.workspaceId, headSha: progress.header?.headSha },
    { phase: "ready", workspaceId: PR_WORKSPACE, headSha: NEW },
  );
  assert.deepEqual(workspaces.fastForwards, [{ workspaceId: PR_WORKSPACE, branch: "pr-7", ref: atNewHead().ref, headSha: NEW }]);
  assert.equal(workspaces.created.length, 1, "the same PR workspace");
  assert.deepEqual(
    agents.created.map((agent) => agent.labels[GUIDE_HEAD_LABEL]),
    [OLD, NEW],
  );
  assert.deepEqual(agents.archived, ["agent-1"], "the guide it replaced ends with it");

  const panel = await service.panel({ workspaceId: PR_WORKSPACE });
  assert.equal(panel.status === "ready" && panel.header.headSha, NEW);
  assert.deepEqual(
    panel.status === "ready" && panel.guide.status === "ready" && panel.guide.guide.nodes.map((node) => node.id),
    ["policy", "upload-loop", "logging"],
  );
  assert.equal((await service.checkHead({ reviewId: REVIEW_ID })).moved, false);

  const guides = path.join(data, "reviews", ...REVIEW_ID.split("/"), "guides");
  assert.equal(JSON.parse(await readFile(path.join(guides, `${NEW}.json`), "utf8")).status, "ready");
  assert.equal(JSON.parse(await readFile(path.join(guides, `${OLD}.json`), "utf8")).agentId, "agent-1", "the old guide stays on disk");
});

test("Regenerate fast-forwards the reviewer's own branch the guide is attached to", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-regenerate-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge();
  forge.changeRequests.set(URL, atOldHead());
  forge.branches.set("github.com/acme/uploader#retry-uploads", [{ ref: atOldHead().ref, title: "Retry failed uploads", author: "author", headSha: OLD }]);
  const workspaces = fakeWorkspaces();
  const checkout = { directory: "/home/r/src/uploader", branch: "retry-uploads", repository: { host: "github.com", project: "acme/uploader" } };
  workspaces.openCheckout("wks_local", { ...checkout, outcome: { status: "current" } });
  const agents = fakeGuideAgents();
  agents.answer = (agent) => sampleGuideReply(agent.labels[GUIDE_HEAD_LABEL] === NEW ? newGuide() : OLD_GUIDE);
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });
  await service.startBranch({ workspaceId: "wks_local", url: null });
  await service.settled();

  forge.changeRequests.set(URL, atNewHead());
  workspaces.openCheckout("wks_local", { ...checkout, outcome: { status: "fast-forwarded", from: OLD } });
  const progress = await regenerate(service);

  assert.equal(progress.workspaceId, "wks_local");
  assert.deepEqual(workspaces.fastForwards.map((entry) => [entry.workspaceId, entry.branch, entry.headSha]), [
    ["wks_local", "retry-uploads", OLD],
    ["wks_local", "retry-uploads", NEW],
  ]);
  assert.deepEqual(workspaces.created, []);
  const panel = await service.panel({ workspaceId: "wks_local" });
  assert.equal(panel.status === "ready" && panel.header.headSha, NEW);
  assert.equal(panel.status === "ready" && panel.guide.status, "ready");
});

test("a force-push the PR workspace cannot fast-forward to moves the guide to a new PR workspace, and says why", async (t) => {
  const { service, forge, workspaces, agents } = await withGuide(t);
  forge.changeRequests.set(URL, atNewHead());
  workspaces.checkouts.get(PR_WORKSPACE)!.outcome = { status: "diverged" };

  const progress = await regenerate(service);

  assert.equal(progress.workspaceId, "wks_0000000000000002");
  assert.equal(workspaces.created.length, 2);
  assert.deepEqual(await service.panel({ workspaceId: PR_WORKSPACE }), { status: "none" });
  const moved = await service.panel({ workspaceId: "wks_0000000000000002" });
  assert.equal(
    moved.status === "ready" && moved.note,
    "The previous PR workspace has commits that are not in #7 any more, so it was left untouched and the guide is in a new PR workspace.",
  );
  assert.equal(moved.status === "ready" && moved.header.headSha, NEW);
  assert.deepEqual(agents.archived, ["agent-1"]);
});

test("Regenerate with the head where the guide is changes nothing", async (t) => {
  const { service, workspaces, agents } = await withGuide(t);

  const progress = await regenerate(service);

  assert.deepEqual({ phase: progress.phase, workspaceId: progress.workspaceId }, { phase: "ready", workspaceId: PR_WORKSPACE });
  assert.equal(agents.created.length, 1);
  assert.deepEqual(agents.archived, []);
  assert.deepEqual(workspaces.fastForwards, []);
  assert.deepEqual(await service.regenerate({ reviewId: "github/github.com/acme/uploader/8" }), {
    status: "rejected",
    message: "This review is not known here any more. Start it again.",
  });
});

test("marks carry over to nodes covering the same code, however renumbered or renamed, and to unchanged entries", async (t) => {
  const { service, forge, restart } = await withGuide(t);
  await mark(service, { kind: "node", nodeId: "retry-policy" });
  await mark(service, { kind: "node", nodeId: "uploader" });
  await mark(service, { kind: "file", path: RETRY_TEST.path });
  await mark(service, { kind: "file", path: RETRY_DOC.path });

  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);

  const carried = {
    headSha: NEW,
    // The uploader's hunk is hunk 2 now and its node is called something else; the policy changed.
    understood: { nodes: ["upload-loop"], files: [RETRY_TEST.path] },
    layers: [
      { understood: 0, total: 2 },
      { understood: 1, total: 1 },
    ],
    tests: { understood: 1, total: 1 },
    docs: { understood: 0, total: 0 },
    supporting: { understood: 0, total: 0 },
    unsorted: { understood: 0, total: 1 },
    overall: { understood: 2, total: 5 },
    nextLayer: 0,
  };
  assert.deepEqual(await service.readingProgress({ reviewId: REVIEW_ID }), carried);
  assert.deepEqual(await restart().readingProgress({ reviewId: REVIEW_ID }), carried, "the carried marks are on disk");

  // Marks at the new head are the new guide's own from here on.
  const after = await mark(service, { kind: "node", nodeId: "logging" }, NEW);
  assert.deepEqual(after.understood, { nodes: ["upload-loop", "logging"], files: [RETRY_TEST.path] });
});

test("a mark on the rest of a partly covered file carries over while that rest is the same", async (t) => {
  const upload = (patch: string): ChangedFile => ({ path: "src/upload.ts", previousPath: null, status: "modified", additions: 2, deletions: 2, patch });
  const covering = (hunks: number[]): Guide => {
    const [policy, uploader] = sampleGuide().nodes as [Guide["nodes"][number], Guide["nodes"][number]];
    return { ...OLD_GUIDE, nodes: [policy, { ...uploader, covers: [{ path: "src/upload.ts", hunks, lines: [] }] }] };
  };
  const oldHead = { ...atOldHead(), files: [upload("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,1 +20,1 @@\n-y\n+z"), ...atOldHead().files.slice(1)] };
  // A hunk added above renumbers the rest without changing it.
  const pushed = upload("@@ -0,0 +1,1 @@\n+log\n@@ -1,1 +2,1 @@\n-a\n+b\n@@ -20,1 +21,1 @@\n-y\n+z");
  const newHead = { ...oldHead, headSha: NEW, files: [pushed, ...oldHead.files.slice(1)] };

  for (const [nextGuide, carried] of [
    [covering([1, 2]), [RETRY_TEST.path, "src/upload.ts"]],
    // The new hunk is left to the entry too, so what it shows changed.
    [covering([2]), [RETRY_TEST.path]],
  ] as const) {
    const { service, forge } = await withGuide(t, { oldHead, oldGuide: covering([1]), nextGuide });
    await mark(service, { kind: "file", path: "src/upload.ts" });
    await mark(service, { kind: "file", path: RETRY_TEST.path });

    forge.changeRequests.set(URL, newHead);
    await regenerate(service);

    assert.deepEqual((await service.readingProgress({ reviewId: REVIEW_ID }))?.understood.files, carried);
  }
});

test("only marks made in the guide kept at the old head carry over", async (t) => {
  const { service, forge } = await withGuide(t);
  await mark(service, { kind: "node", nodeId: "uploader" });
  // "Try again" at the same head: a guide of its own, in which nothing was marked.
  await service.generateGuide({ reviewId: REVIEW_ID });
  await service.settled();

  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);

  assert.deepEqual((await service.readingProgress({ reviewId: REVIEW_ID }))?.understood, { nodes: [], files: [] });
});

test("a regenerated guide that failed carries the marks over once Try again writes it", async (t) => {
  const { service, forge, agents } = await withGuide(t);
  await mark(service, { kind: "node", nodeId: "uploader" });

  forge.changeRequests.set(URL, atNewHead());
  agents.answer = () => "I could not read the change.";
  await regenerate(service);
  const panel = await service.panel({ workspaceId: PR_WORKSPACE });
  assert.equal(panel.status === "ready" && panel.guide.status, "failed");

  agents.answer = () => sampleGuideReply(newGuide());
  await service.generateGuide({ reviewId: REVIEW_ID });
  await service.settled();

  assert.deepEqual((await service.readingProgress({ reviewId: REVIEW_ID }))?.understood, { nodes: ["upload-loop"], files: [] });
});

test("after Regenerate a comment is anchored in the new head's diff, one from the guide it replaced is refused, and drafts stay", async (t) => {
  const { service, forge } = await withGuide(t);
  const before = await service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: { kind: "file", path: "src/upload.ts" }, body: "Why?" });

  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);

  // New line 1 was `b` at the old head and is a new `log` at this one: a panel still drawing the old
  // guide must not put its comment there.
  const onB = { kind: "line", path: "src/upload.ts", line: { side: "new", line: 1 } } as const;
  await assert.rejects(
    service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: onB, body: "Is b right?" }),
    new Error("This comment is on the guide at bbbbbbb, which was regenerated for ddddddd. Comment on the guide at the new head."),
  );

  await service.createDraft({ reviewId: REVIEW_ID, headSha: NEW, location: { ...onB, line: { side: "new", line: 3 } }, body: "Is b right?" });
  const created = forge.created.at(-1)!;
  assert.equal(created.target.headSha, NEW);
  assert.deepEqual(created.anchor.kind === "line" && [created.anchor.line.kind, created.anchor.line.newLine], ["added", 3]);
  assert.equal(forge.created.length, 2);

  assert.deepEqual(
    (await service.listDrafts({ reviewId: REVIEW_ID })).drafts.map((draft) => draft.id),
    [before.id, forge.drafts.get(URL)!.at(-1)!.id],
    "Regenerate leaves the forge's drafts alone",
  );
});

test("after Regenerate a draft's node is the new guide's node with the same code, and none where the code changed", async (t) => {
  const { service, forge } = await withGuide(t);
  const general = { kind: "general" } as const;
  await service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: general, body: "About the upload loop: why?", from: node("uploader") });
  await service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: general, body: "About the retry handling: why?", from: node("retry-policy") });

  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);

  assert.deepEqual(
    (await service.listDrafts({ reviewId: REVIEW_ID })).drafts.map((draft) => [draft.body, draft.from]),
    [
      ["About the upload loop: why?", node("upload-loop")],
      ["About the retry handling: why?", null],
    ],
  );
});

test("after Regenerate a comment on the overview stays on the overview, and its passage is marked as from an earlier guide", async (t) => {
  const { service, forge } = await withGuide(t);
  const general = { kind: "general" } as const;
  const passage = "An upload is retried only when the failure is transient";
  await service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: general, body: "Why not on a 429?", from: { kind: "overview" }, quote: passage });
  await service.createDraft({ reviewId: REVIEW_ID, headSha: OLD, location: general, body: "Why here?", from: node("uploader"), quote: "the upload loop" });

  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);

  assert.deepEqual(
    (await service.listDrafts({ reviewId: REVIEW_ID })).drafts.map((draft) => [draft.body, draft.from, draft.quote]),
    [
      ["Why not on a 429?", { kind: "overview" }, { text: passage, earlier: true }],
      ["Why here?", node("upload-loop"), { text: "the upload loop", earlier: true }],
    ],
  );
});

test("after Regenerate, wording is suggested from the new head's lines, and a request from the guide it replaced is refused", async (t) => {
  const { service, forge, agents } = await withGuide(t);
  forge.changeRequests.set(URL, atNewHead());
  await regenerate(service);
  agents.answer = () => '```json\n{ "body": "Is b right?" }\n```';
  const sentBefore = agents.created.map((agent) => agent.sent.length);

  // New line 1 is a new `log` at this head and was `b` at the old one: the old guide's box must not
  // have it worded from the new head's line of that number.
  const onLine = (line: number) => ({ kind: "code", location: { kind: "line", path: "src/upload.ts", line: { side: "new", line } } }) as const;
  assert.deepEqual(await service.suggestWording({ reviewId: REVIEW_ID, headSha: OLD, subject: onLine(1), prompt: "b?" }), {
    status: "failed",
    message: "This comment is on the guide at bbbbbbb, which was regenerated for ddddddd. Comment on the guide at the new head.",
  });
  assert.deepEqual(
    agents.created.map((agent) => agent.sent.length),
    sentBefore,
    "no agent is asked",
  );

  const started = await service.suggestWording({ reviewId: REVIEW_ID, headSha: NEW, subject: onLine(3), prompt: "b?" });
  assert.equal(started.status, "running");
  await service.settled();
  assert.deepEqual(await service.suggestion({ suggestionId: started.status === "running" ? started.suggestionId : "" }), { status: "ready", body: "Is b right?" });
  const prompt = agents.created.at(-1)!.sent.at(-1)!;
  assert.match(prompt, /at dddddddddddd/);
  assert.match(prompt, /It goes on line 3 of src\/upload\.ts\. The line as the diff shows it:\n```diff\n\+b\n```/);
  assert.match(prompt, /- "upload-loop", /, "the node is the new guide's");
  assert.deepEqual(forge.created, []);
});
