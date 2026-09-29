import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { DiffHunk, DiffLine } from "../shared/diff.ts";
import type { Guide } from "../shared/guide.ts";
import { fakeCommandRunner } from "./fake-command-runner.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuide, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces } from "./fake-workspaces.ts";
import { createGitHubForge } from "./forge/github.ts";
import { createGitLabForge } from "./forge/gitlab.ts";
import type { ChangeRequest, ChangeRequestRef } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

/**
 * The display-ready hunks the panel draws under each node, driven through the RPCs it calls, over
 * diffs the forge adapters read from recorded `gh` and `glab` output.
 */

function fixture(forge: "github" | "gitlab", name: string): string {
  return readFileSync(path.join(import.meta.dirname, "forge", "fixtures", forge, name), "utf8");
}

const PR_105: ChangeRequestRef = {
  forge: "github",
  host: "github.com",
  project: "sleeyax/paseo-plugins",
  number: 105,
  url: "https://github.com/sleeyax/paseo-plugins/pull/105",
};

const MR_3931: ChangeRequestRef = {
  forge: "gitlab",
  host: "gitlab.com",
  project: "gitlab-org/cli",
  number: 3931,
  url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
};

/** sleeyax/paseo-plugins#105 as the GitHub adapter reads it from recorded `gh` output. */
async function recordedPullRequest(): Promise<ChangeRequest> {
  const run = fakeCommandRunner([{ stdout: fixture("github", "pull-request.json") }, { stdout: fixture("github", "files.json") }]);
  return createGitHubForge({ run, gh: async () => "gh" }).fetchChangeRequest(PR_105);
}

/** gitlab-org/cli!3931 as the GitLab adapter reads it from recorded `glab` output. */
async function recordedMergeRequest(): Promise<ChangeRequest> {
  const run = fakeCommandRunner([
    { stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as reviewer\n" },
    { stdout: fixture("gitlab", "project.json") },
    { stdout: fixture("gitlab", "merge-request.json") },
    { stdout: fixture("gitlab", "diffs.ndjson") },
    { stdout: fixture("gitlab", "commits.json") },
    { stdout: fixture("gitlab", "closes-issues.json") },
  ]);
  return createGitLabForge({ run, glab: async () => "glab" }).fetchChangeRequest(MR_3931);
}

type Host = { service: ReviewService; agents: FakeGuideAgents; forge: FakeForge; reviewId: string };

/** A service whose forge holds `changeRequest` and whose guide agent answers with `guide`, started and settled. */
async function reviewing(t: TestContext, changeRequest: ChangeRequest, guide: unknown): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-hunks-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const forge = fakeForge(changeRequest.ref.forge);
  forge.changeRequests.set(changeRequest.ref.url, changeRequest);
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set(`${changeRequest.ref.host}/${changeRequest.ref.project}`, "/home/r/src/repo");
  const agents = fakeGuideAgents();
  agents.answer = () => sampleGuideReply(guide);
  const service = new ReviewService({ forges: [forge], workspaces, guideAgents: agents, dataDirectory: data });

  const started = await service.start({ url: changeRequest.ref.url });
  await service.settled();
  assert.equal(started.status, "started");
  const reviewId = started.status === "started" ? started.reviewId : "";
  const panel = await service.panel({ workspaceId: "wks_0000000000000001" });
  assert.equal(panel.status === "ready" && panel.guide.status, "ready", "the guide is valid");
  return { service, agents, forge, reviewId };
}

/** A guide over `nodes`, each given as its ID and what it covers. */
function guideOver(nodes: Record<string, Guide["nodes"][number]["covers"]>): Guide {
  const base = sampleGuide().nodes[0]!;
  const ids = Object.keys(nodes);
  return {
    overview: { ...sampleGuide().overview, attention: [{ nodeId: ids[0]!, reason: "It is first." }] },
    nodes: ids.map((id) => ({ ...base, id, title: id, covers: nodes[id]! })),
    supporting: [],
  };
}

/** A line as `kind old new oldPos_newPos`: what a draft anchored on it would need. */
function numbering(lines: readonly DiffLine[]): string[] {
  return lines.map((line) => `${line.kind} ${line.oldLine ?? "-"} ${line.newLine ?? "-"} ${line.oldPos}_${line.newPos}${line.noNewlineAtEnd ? " eof" : ""}`);
}

function headerOf(hunk: DiffHunk) {
  return { index: hunk.index, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, complete: hunk.complete };
}

test("a node's hunks from a recorded GitHub PR carry their old and new line numbers, only the hunks it names", async (t) => {
  const changeRequest = await recordedPullRequest();
  const guide = guideOver({
    "menu-keys": [{ path: "apps/claude-tty-acp/src/claude-runtime.test.ts", hunks: [1, 3], lines: [] }],
    "sdk-bump": [
      { path: "plugins/claude-tty/package.json", hunks: [], lines: [] },
      { path: "apps/claude-tty-acp/src/claude-runtime.test.ts", hunks: [2], lines: [] },
    ],
  });
  const { service, reviewId } = await reviewing(t, changeRequest, guide);

  const menuKeys = await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "menu-keys" } });
  assert.equal(menuKeys.headSha, changeRequest.headSha);
  const [runtime] = menuKeys.files;
  assert.deepEqual(
    { path: runtime!.path, status: runtime!.status, withheld: runtime!.withheld, hunkCount: runtime!.hunkCount },
    { path: "apps/claude-tty-acp/src/claude-runtime.test.ts", status: "modified", withheld: false, hunkCount: 7 },
  );
  assert.deepEqual(runtime!.hunks.map(headerOf), [
    { index: 1, oldStart: 20, oldLines: 6, newStart: 20, newLines: 8, complete: true },
    { index: 3, oldStart: 341, oldLines: 14, newStart: 360, newLines: 14, complete: true },
  ]);
  assert.equal(runtime!.hunks[0]!.section, 'const CLEAR_INPUT_LINE = "\\^U";');
  assert.deepEqual(numbering(runtime!.hunks[0]!.lines), [
    "context 20 20 20_20",
    "context 21 21 21_21",
    "context 22 22 22_22",
    "added - 23 23_23",
    "added - 24 23_24",
    "context 23 25 23_25",
    "context 24 26 24_26",
    "context 25 27 25_27",
  ]);
  assert.equal(runtime!.hunks[0]!.lines[4]!.text, 'const CURSOR_DOWN = "\\^[[B";');

  const sdkBump = await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "sdk-bump" } });
  assert.deepEqual(
    sdkBump.files.map((file) => [file.path, file.hunks.map((hunk) => hunk.index)]),
    [
      ["plugins/claude-tty/package.json", [1]],
      ["apps/claude-tty-acp/src/claude-runtime.test.ts", [2]],
    ],
  );
  assert.deepEqual(numbering(sdkBump.files[0]!.hunks[0]!.lines), [
    "context 8 8 8_8",
    "context 9 9 9_9",
    "context 10 10 10_10",
    "removed 11 - 11_11",
    "removed 12 - 12_11",
    "added - 11 13_11",
    "added - 12 13_12",
    "context 13 13 13_13",
    "context 14 14 14_14",
    "context 15 15 15_15",
  ]);
});

test("a node can take part of a hunk from a recorded GitLab MR, keeping GitLab's counters for line codes", async (t) => {
  const changeRequest = await recordedMergeRequest();
  const discussions = "internal/commands/mr/mrutils/discussions.go";
  const guide = guideOver({
    "internal-threads": [
      { path: "docs/source/mr/note/create.md", hunks: [1], lines: [] },
      { path: discussions, hunks: [], lines: [{ start: 185, end: 192 }] },
    ],
    "resolve-discussion": [
      {
        path: discussions,
        hunks: [],
        lines: [
          { start: 143, end: 184 },
          { start: 193, end: 194 },
        ],
      },
    ],
  });
  const { service, reviewId } = await reviewing(t, changeRequest, guide);

  const internal = await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "internal-threads" } });
  assert.deepEqual(
    internal.files.map((file) => file.path),
    ["docs/source/mr/note/create.md", discussions],
  );
  assert.deepEqual(internal.files[0]!.hunks.map(headerOf), [{ index: 1, oldStart: 22, oldLines: 6, newStart: 22, newLines: 8, complete: true }]);
  const [part] = internal.files[1]!.hunks;
  assert.deepEqual(headerOf(part!), { index: 1, oldStart: 167, oldLines: 2, newStart: 185, newLines: 8, complete: false });
  assert.equal(part!.section, "func matchesType(discussion *gitlab.Discussion, typ string) bool {");
  assert.deepEqual(numbering(part!.lines), [
    "added - 185 167_185",
    "added - 186 167_186",
    "added - 187 167_187",
    "added - 188 167_188",
    "added - 189 167_189",
    "context 167 190 167_190",
    "added - 191 168_191",
    "context 168 192 168_192",
  ]);
  assert.equal(part!.lines[2]!.text, "func IsInternalDiscussion(discussion *gitlab.Discussion) bool {");

  // The rest of the hunk is the other node's, in two parts either side of this one's lines.
  const resolve = await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "resolve-discussion" } });
  const [before, after] = resolve.files[0]!.hunks;
  assert.deepEqual(resolve.files[0]!.hunks.map(headerOf), [
    { index: 1, oldStart: 143, oldLines: 24, newStart: 143, newLines: 42, complete: false },
    { index: 1, oldStart: 169, oldLines: 2, newStart: 193, newLines: 2, complete: false },
  ]);
  assert.equal(before!.lines.length + part!.lines.length + after!.lines.length, changeRequest.files[1]!.patch!.split("\n").length - 1);
});

test("added, removed, renamed and binary files, and a missing newline at the end, each read sensibly", async (t) => {
  const url = "https://github.com/acme/uploader/pull/7";
  const changeRequest = sampleChangeRequest(url, {
    files: [
      { path: "src/new.ts", previousPath: null, status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file" },
      { path: "src/old.ts", previousPath: null, status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-gone" },
      { path: "src/moved.ts", previousPath: "src/before.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "logo.png", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null },
      {
        path: "src/edge.ts",
        previousPath: "src/edges.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -4,2 +4,2 @@ export\n keep\n-last\n\\ No newline at end of file\n+last;\n\\ No newline at end of file",
      },
    ],
  });
  const guide = guideOver({
    files: changeRequest.files.map((file) => ({ path: file.path, hunks: [], lines: [] })),
  });
  const { service, reviewId } = await reviewing(t, changeRequest, guide);

  const { files } = await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "files" } });

  assert.deepEqual(
    files.map(({ path, previousPath, status, withheld, hunkCount }) => ({ path, previousPath, status, withheld, hunkCount })),
    [
      { path: "src/new.ts", previousPath: null, status: "added", withheld: false, hunkCount: 1 },
      { path: "src/old.ts", previousPath: null, status: "removed", withheld: false, hunkCount: 1 },
      { path: "src/moved.ts", previousPath: "src/before.ts", status: "renamed", withheld: true, hunkCount: 0 },
      { path: "logo.png", previousPath: null, status: "modified", withheld: true, hunkCount: 0 },
      { path: "src/edge.ts", previousPath: "src/edges.ts", status: "renamed", withheld: false, hunkCount: 1 },
    ],
  );
  assert.deepEqual(numbering(files[0]!.hunks[0]!.lines), ["added - 1 0_1", "added - 2 0_2 eof"]);
  assert.deepEqual(numbering(files[1]!.hunks[0]!.lines), ["removed 1 - 1_0"]);
  assert.deepEqual(files[2]!.hunks, []);
  assert.deepEqual(numbering(files[4]!.hunks[0]!.lines), ["context 4 4 4_4", "removed 5 - 5_5 eof", "added - 5 6_5 eof"]);
});

test("asking for a node's hunks before the guide is ready, or for a node it lacks, says why", async (t) => {
  const url = "https://github.com/acme/uploader/pull/7";
  const { service, agents, reviewId } = await reviewing(t, sampleChangeRequest(url), sampleGuide());

  await assert.rejects(service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "backoff" } }), { message: 'The guide has no concept "backoff". Reopen the panel.' });
  await assert.rejects(service.nodeDiff({ reviewId: "github/github.com/acme/other/1", subject: { kind: "node", nodeId: "uploader" } }), {
    message: "This review is not known here any more. Start it again.",
  });

  let release: ((reply: string) => void) | undefined;
  agents.answer = () => new Promise<string>((resolve) => (release = resolve));
  await service.generateGuide({ reviewId });
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "uploader" } }), { message: "The guide is not ready yet." });

  release(sampleGuideReply());
  await service.settled();
  assert.equal((await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "uploader" } })).files[0]!.path, "src/upload.ts");
});

test("a Supporting or Unsorted file no node covers shows its whole diff, and a path the change lacks says why", async (t) => {
  const url = "https://github.com/acme/uploader/pull/7";
  const base = sampleChangeRequest(url);
  const retryTest = {
    path: "src/retry.test.ts",
    previousPath: null,
    status: "added" as const,
    additions: 3,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+it(\"retries\");\n+it(\"gives up\");\n@@ -0,0 +10,1 @@\n+it(\"backs off\");",
  };
  const doc = { path: "docs/retry.md", previousPath: null, status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -3,1 +3,1 @@\n-old\n+new" };
  const { service, reviewId } = await reviewing(t, { ...base, files: [...base.files, retryTest, doc] }, { ...sampleGuide(), supporting: [{ path: retryTest.path, category: "test" }] });

  const supporting = await service.nodeDiff({ reviewId, subject: { kind: "file", path: retryTest.path } });
  assert.equal(supporting.headSha, base.headSha);
  assert.equal(supporting.files.length, 1);
  assert.equal(supporting.files[0]!.path, retryTest.path);
  assert.equal(supporting.files[0]!.hunkCount, 2);
  assert.deepEqual(supporting.files[0]!.hunks.map(headerOf), [
    { index: 1, oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, complete: true },
    { index: 2, oldStart: 0, oldLines: 0, newStart: 10, newLines: 1, complete: true },
  ]);
  assert.deepEqual(numbering(supporting.files[0]!.hunks[1]!.lines), ["added - 10 0_10"]);

  const unsorted = await service.nodeDiff({ reviewId, subject: { kind: "file", path: doc.path } });
  assert.deepEqual(numbering(unsorted.files[0]!.hunks[0]!.lines), ["removed 3 - 3_3", "added - 3 4_3"]);

  await assert.rejects(service.nodeDiff({ reviewId, subject: { kind: "file", path: "src/other.ts" } }), {
    message: "src/other.ts is not one of the change's files.",
  });
});

test("an entry of a file some node covers part of holds the rest of it, which takes marks and comments like any entry", async (t) => {
  const url = "https://github.com/acme/uploader/pull/7";
  const base = sampleChangeRequest(url);
  const upload = { ...base.files[0]!, patch: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,3 +20,4 @@ retry\n x\n-y\n+y1\n+y2\n z" };
  const wire = { path: "src/wire.ts", previousPath: null, status: "modified" as const, additions: 3, deletions: 0, patch: "@@ -1,2 +1,5 @@\n a\n+one\n+two\n b\n+three" };
  const guide = {
    ...guideOver({
      uploader: [{ path: "src/upload.ts", hunks: [1], lines: [] }],
      retry: [
        { path: "src/retry.ts", hunks: [], lines: [] },
        // The first added line only: the rest of the hunk has changes left.
        { path: "src/wire.ts", hunks: [], lines: [{ start: 2, end: 2 }] },
      ],
    }),
    supporting: [{ path: "src/upload.ts", category: "wiring" as const }],
  };
  const { service, forge, reviewId } = await reviewing(t, { ...base, files: [upload, base.files[1]!, wire] }, guide);

  const panel = await service.panel({ workspaceId: "wks_0000000000000001" });
  assert.ok(panel.status === "ready" && panel.guide.status === "ready");
  assert.deepEqual(panel.guide.guide.supporting, [{ path: "src/upload.ts", category: "wiring" }]);
  assert.deepEqual(panel.guide.guide.unsorted, ["src/wire.ts"]);

  const supporting = await service.nodeDiff({ reviewId, subject: { kind: "file", path: "src/upload.ts" } });
  assert.equal(supporting.files[0]!.hunkCount, 2);
  assert.deepEqual(supporting.files[0]!.hunks.map(headerOf), [{ index: 2, oldStart: 20, oldLines: 3, newStart: 20, newLines: 4, complete: true }]);

  const unsorted = await service.nodeDiff({ reviewId, subject: { kind: "file", path: "src/wire.ts" } });
  assert.deepEqual(unsorted.files[0]!.hunks.map(headerOf), [{ index: 1, oldStart: 2, oldLines: 1, newStart: 3, newLines: 3, complete: false }]);
  assert.deepEqual(numbering(unsorted.files[0]!.hunks[0]!.lines), ["added - 3 2_3", "context 2 4 2_4", "added - 5 3_5"]);

  const progress = await service.setUnderstood({ reviewId, headSha: base.headSha, subject: { kind: "file", path: "src/wire.ts" }, understood: true });
  assert.deepEqual(progress.understood.files, ["src/wire.ts"]);
  assert.deepEqual(progress.unsorted, { understood: 1, total: 1 });

  const draft = await service.createDraft({
    reviewId,
    headSha: base.headSha,
    location: { kind: "line", path: "src/upload.ts", line: { side: "new", line: 21 } },
    body: "Why two lines?",
  });
  assert.deepEqual(draft.location, { kind: "line", path: "src/upload.ts", line: { side: "new", line: 21 } });
  assert.equal(forge.created.length, 1);
});

test("a node's lines carry Paseo's syntax tokens, read from the hunks where the workspace has no file to read", async (t) => {
  const changeRequest = await recordedPullRequest();
  const guide = guideOver({ "menu-keys": [{ path: "apps/claude-tty-acp/src/claude-runtime.test.ts", hunks: [1], lines: [] }] });
  const { service, reviewId } = await reviewing(t, changeRequest, guide);

  const [runtime] = (await service.nodeDiff({ reviewId, subject: { kind: "node", nodeId: "menu-keys" } })).files;
  const lines = runtime!.hunks[0]!.lines;
  assert.ok(lines.every((line) => line.tokens?.map((token) => token.text).join("") === line.text));
  assert.deepEqual(
    lines[4]!.tokens!.filter((token) => token.style !== null && token.style !== "punctuation").map((token) => [token.text, token.style]),
    [
      ["const", "keyword"],
      ["CURSOR_DOWN", "definition"],
      ["=", "operator"],
      ['"', "string"],
      ["\\^", "escape"],
      ['[[B"', "string"],
    ],
  );
});

test("the diffs are coloured with Paseo's default syntax palettes", async () => {
  const { darkHighlightColors, lightHighlightColors } = await import("@getpaseo/highlight");
  const service = new ReviewService({ forges: [], workspaces: fakeWorkspaces(), guideAgents: fakeGuideAgents(), dataDirectory: os.tmpdir() });
  assert.deepEqual(await service.syntaxColors(), { dark: darkHighlightColors, light: lightHighlightColors });
});
