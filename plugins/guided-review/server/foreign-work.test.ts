import assert from "node:assert/strict";
import test from "node:test";
import { headsUpNote, type ForeignWork } from "../shared/foreign-work.ts";
import { sampleChangeRequest } from "./fake-forge.ts";
import type { ChangeRequest, CommitChangeRequest } from "./forge/port.ts";
import { foreignWorkOf } from "./foreign-work.ts";

const URL = "https://gitlab.com/acme/app/-/merge_requests/624";
const BASE = "base";

const PROBLEM_DETAILS: CommitChangeRequest = {
  number: 551,
  url: "https://gitlab.com/acme/app/-/merge_requests/551",
  title: "Serve one error shape",
  state: "merged",
  sourceBranch: "feat/problem-details",
  targetBranch: "env/develop",
};

/** A change request whose commits, oldest first, are `[sha, ...parents]`, its head the last. */
function withHistory(history: [string, ...string[]][]): ChangeRequest {
  return sampleChangeRequest(URL, {
    baseBranch: "feat/target",
    headBranch: "feat/own",
    headSha: history.at(-1)![0],
    commits: history.map(([sha, ...parents]) => ({ sha, headline: sha, body: "", author: "author", authoredAt: "2026-10-01T00:00:00Z", parents })),
  });
}

function belongingTo(other: CommitChangeRequest, shas: string[]): Map<string, CommitChangeRequest[]> {
  return new Map(shas.map((sha) => [sha, [other]]));
}

test("another MR's work merged in at the bottom is foreign, and the own work starts after the merge", () => {
  const changeRequest = withHistory([
    ["f1", BASE],
    ["f2", "f1"],
    ["f3", "f2"],
    ["merge", BASE, "f3"],
    ["o1", "merge"],
    ["o2", "o1"],
  ]);

  assert.deepEqual(foreignWorkOf(changeRequest, belongingTo(PROBLEM_DETAILS, ["f1", "f2", "f3"])), {
    targetBranch: "feat/target",
    changeRequests: [{ ...PROBLEM_DETAILS, commits: ["f1", "f2", "f3"] }],
    foreignCommits: 3,
    totalCommits: 6,
    truncated: false,
    ownFrom: "o1",
  });
});

test("a branch cut from another MR's branch has its own work start after that branch's commits", () => {
  const changeRequest = withHistory([
    ["f1", BASE],
    ["f2", "f1"],
    ["o1", "f2"],
  ]);

  assert.equal(foreignWorkOf(changeRequest, belongingTo(PROBLEM_DETAILS, ["f1", "f2"]))?.ownFrom, "o1");
});

test("foreign work merged in after own commits leaves no start of own work", () => {
  const changeRequest = withHistory([
    ["o1", BASE],
    ["f1", BASE],
    ["merge", "o1", "f1"],
    ["o2", "merge"],
  ]);

  const work = foreignWorkOf(changeRequest, belongingTo(PROBLEM_DETAILS, ["f1"]));
  assert.equal(work?.foreignCommits, 1);
  assert.equal(work?.ownFrom, null);
});

test("a change request that is all foreign work has no own work to start", () => {
  const changeRequest = withHistory([
    ["f1", BASE],
    ["f2", "f1"],
  ]);

  assert.equal(foreignWorkOf(changeRequest, belongingTo(PROBLEM_DETAILS, ["f1", "f2"]))?.ownFrom, null);
});

test("merging the target in is not own work, so the own work still starts after it", () => {
  const changeRequest = withHistory([
    ["f1", BASE],
    ["merge", BASE, "f1"],
    ["sync", "merge", "target-tip"],
    ["o1", "sync"],
  ]);

  assert.equal(foreignWorkOf(changeRequest, belongingTo(PROBLEM_DETAILS, ["f1"]))?.ownFrom, "o1");
});

test("the change request itself, an earlier one from its branch and a closed one are not foreign", () => {
  const changeRequest = withHistory([
    ["o1", BASE],
    ["o2", "o1"],
  ]);
  const own = { ...PROBLEM_DETAILS, number: 624, sourceBranch: "feat/own", state: "open" as const };
  const earlier = { ...PROBLEM_DETAILS, number: 600, sourceBranch: "feat/own", state: "closed" as const };
  const closed = { ...PROBLEM_DETAILS, number: 610, state: "closed" as const };

  assert.equal(
    foreignWorkOf(
      changeRequest,
      new Map([
        ["o1", [own, earlier, closed]],
        ["o2", [own]],
      ]),
    ),
    null,
  );
});

test("an open MR's commits are foreign, each commit counted once however many MRs it is in", () => {
  const changeRequest = withHistory([
    ["f1", BASE],
    ["o1", "f1"],
  ]);
  const stacked = { ...PROBLEM_DETAILS, number: 700, state: "open" as const, sourceBranch: "feat/stacked" };

  const work = foreignWorkOf(changeRequest, new Map([["f1", [PROBLEM_DETAILS, stacked]]]));
  assert.deepEqual(
    work?.changeRequests.map((other) => [other.number, other.state, other.commits]),
    [
      [551, "merged", ["f1"]],
      [700, "open", ["f1"]],
    ],
  );
  assert.equal(work?.foreignCommits, 1);
});

test("a commit list the forge cut off is marked truncated and gives no start of own work", () => {
  const history: [string, ...string[]][] = Array.from({ length: 100 }, (_, index) => [`c${index}`, index === 0 ? BASE : `c${index - 1}`]);
  const work = foreignWorkOf(withHistory(history), belongingTo(PROBLEM_DETAILS, ["c0"]));

  assert.equal(work?.truncated, true);
  assert.equal(work?.ownFrom, null);
});

const NOTE_WORK: ForeignWork = {
  targetBranch: "feat/paid-by-mediator",
  changeRequests: [
    { ...PROBLEM_DETAILS, state: "merged", commits: ["92b39932aaaa", "61226638aaaa", "629dd6f3aaaa"] },
    { ...PROBLEM_DETAILS, number: 700, state: "open", sourceBranch: "feat/stacked", commits: ["70000000aaaa"] },
  ],
  foreignCommits: 4,
  totalCommits: 9,
  truncated: false,
  ownFrom: "9b3dac0caaaa",
};

test("the heads-up names each foreign MR, what to do about it and where the own work starts", () => {
  assert.equal(
    headsUpNote(NOTE_WORK, "gitlab"),
    [
      "Heads-up: 4 of this MR's 9 commits come from other MRs, so the diff shows their changes as this MR's:",
      "",
      "- !551 (`92b3993`…`629dd6f`) landed in `env/develop` but isn't in `feat/paid-by-mediator` yet: retarget this MR to `env/develop`, or bring !551 into `feat/paid-by-mediator`.",
      "- !700 (`7000000`) is still open: target its branch `feat/stacked` so this MR stacks on it, or wait for it to land in `feat/paid-by-mediator`.",
      "",
      "This MR's own work is only the commits from `9b3dac0` onward.",
      "Could you sort that out, so the diff shows only this MR's changes?",
    ].join("\n"),
  );
});

test("the heads-up says at least when the commits were cut off, and leaves out an own work it cannot place", () => {
  const note = headsUpNote({ ...NOTE_WORK, truncated: true, ownFrom: null }, "github");

  assert.match(note, /^Heads-up: at least 4 of this PR's commits come from other PRs/);
  assert.match(note, /- #551 /);
  assert.doesNotMatch(note, /own work/);
});
