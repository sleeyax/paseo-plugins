---
name: adopt-paseo-release
description: Review the Paseo releases since the last review and file a GitHub issue with what these plugins should adopt.
disable-model-invocation: true
---

# Adopt a Paseo release

A run turns the Paseo releases since the **baseline** (the newest version already reviewed) into one issue whose **parts** an agent can each land as its own PR.
Each part rests on a **finding**: a change in Paseo, tied to the files in this repo it affects and to the release note, doc passage or SDK line that proves it.

The skill is shell commands, `git` and `gh`; nothing here is specific to one coding agent.
It reads this repository and writes only to GitHub, and only after the user approves the draft.

## Requirements

`git` and `gh` must be on `PATH`, and `gh` must be authenticated for the repository. If either fails, say which and stop.

## Steps

### 0. Confirm the checkout

```sh
git rev-parse --show-toplevel
gh repo view --json nameWithOwner,defaultBranchRef
git fetch --quiet origin
git status --short --branch
```

The root must hold `pnpm-workspace.yaml` and `plugins/*/paseo-plugin.json`; otherwise this is not the paseo-plugins checkout, so say so and stop.

The run analyses the working copy as it is.
When `HEAD` is not the default branch, the tree is dirty, or the branch is behind `origin`, warn the user in one line naming which, because findings will then describe that copy rather than what is released, and carry on.

### 1. Find the baseline and the releases after it

```sh
gh issue list --label paseo-release --state all --limit 20 --json number,title,createdAt
gh release list -R getpaseo/paseo --exclude-pre-releases --limit 50 --json tagName,publishedAt
```

The baseline is, in order of precedence:

1. a version the user named for this run;
2. the highest version in the title of the most recently created `paseo-release` issue (`Adopt Paseo 0.11.0: …` gives `0.11.0`; `Adopt Paseo 0.11.1–0.12.0: …` gives `0.12.0`);
3. with no such issue, the lowest `@getpaseo/plugin` version across `plugins/*/package.json` and `apps/*/package.json`.

The releases to review are the stable ones newer than the baseline, by semver.
Betas are skipped; their notes reappear in the stable release.
With none, report the baseline and the newest release and stop: there is nothing to file.

### 2. Get Paseo's source at both tags

Keep one blobless clone in a cache and reuse it across runs:

```sh
src="${XDG_CACHE_HOME:-$HOME/.cache}/paseo-src"
[ -d "$src/.git" ] || git clone --quiet --filter=blob:none --no-checkout https://github.com/getpaseo/paseo.git "$src"
git -C "$src" fetch --quiet --tags origin
```

Read, for the range from the baseline tag to the newest tag:

- every release's notes: `gh release view <tag> -R getpaseo/paseo --json body -q .body`, the **Plugins** section first, then **Fixed** and **Changed**;
- the plugin docs and SDK diff: `git -C "$src" diff <from> <to> -- public-docs/plugins packages/plugin/src ':!*.test.ts'`;
- a doc whole at the new tag, when a diff hunk lacks context: `git -C "$src" show <to>:public-docs/plugins/reference.md`.

Read daemon source (`packages/server`) only to settle a specific question a finding raises, such as what the daemon does when an optional registration field is absent.

### 3. Read this repository's side

- Every package under `plugins/` and `apps/`: its `paseo-plugin.json`, `package.json`, entries (`index.client.tsx`, `index.server.ts`), and the `client/`, `server/` and `shared/` modules a finding touches.
- Every package's `CLAUDE.md`. By the root `CLAUDE.md`'s rule it records only what Paseo's reference does not, so it is where this repo's **workarounds** live: the limits, gotchas and hand-written substitutes that exist because Paseo lacked something.
- Every README section that shows a `paseo` command, including the root `README.md` and the README template in the root `CLAUDE.md`.
- Open issues: `gh issue list --state open --limit 200 --json number,title,labels,body`. Note the ones waiting on a Paseo version ("Blocked on Paseo 0.11"), the open `bug` issues, and any that already cover a change you are about to propose.

Unmerged branches are out of scope; their own issues track them.

### 4. Collect the findings

Work through every release note entry in the range and every hunk of the docs and SDK diff, and decide for each whether it is a finding.
Three kinds qualify, in this priority:

1. **Breaking**: something in this repo stops working, or a documented command or API it uses changes meaning or becomes deprecated. Always a part, however small.
2. **Retired workaround**: a release fixes or adds what a workaround in a package's `CLAUDE.md` or code exists to cover. The part names the workaround (file and `CLAUDE.md` passage), the upstream change (release note line and PR link), and how to check that the change covers this repo's case; the implementing agent keeps the workaround, and says why in the PR, when the check fails.
3. **Improvement**: a new capability that changes what a user of a plugin sees or relies on today, or removes code. A capability that would only be nice to have becomes a one-line idea; one no plugin can use goes under "Not in scope".

Every finding:

- names the files in this repo it affects and links the release note, doc passage or SDK line that justifies it, pinned to the tag (`https://github.com/getpaseo/paseo/blob/<tag>/public-docs/plugins/reference.md`);
- links an existing issue that already covers it instead of restating it, and says the existing issue is out of scope here;
- states whether it raises a plugin's `requirements.paseo` and `@getpaseo/plugin` version;
- carries any trap the docs make easy to miss, such as an optional field whose presence changes what the daemon passes in.

An open issue waiting on a version in the range is **unblocked**; an open `bug` a **Fixed** entry may resolve is a **candidate fix**. Both get a comment in step 6, and the issue links them.

Something outside this repository, such as a registry record or a PR on `getpaseo/plugins` that looks wrong, is not a part: an agent must not act on it. Keep it for the summary in step 7.

The step is done when every release note entry and every diff hunk has been either turned into a finding, an idea, or a "Not in scope" line, or dismissed as irrelevant to every package.

### 5. Draft the issue and the comments

Write the drafts to a temporary directory (`mktemp -d`).

Title: `Adopt Paseo <version>: <summary>` for one release, `Adopt Paseo <from>–<to>: <summary>` for several, where `<from>` is the oldest reviewed release and `<to>` the newest; the summary names the parts in a few words.
Labels: `paseo-release`, `enhancement`, `ready-for-agent`.

One issue covers the whole range, grouped by finding rather than by release, with each finding citing the release it comes from.
Body sections, one sentence per line:

- **Context**: the releases covered, with links, and which docs at the new tag to read before starting.
- **Numbered parts**: one per breaking change, retired workaround or improvement, in that priority. Each says what to change and where, the evidence, any trap, whether it raises the minimum Paseo version, and what is out of scope for it. Say which part lands first when one blocks users today; otherwise the parts are independent.
- **Unblocked and possibly fixed issues**: links, and that they are tracked there.
- **Ideas**: one line each, no acceptance criteria. Omit when empty.
- **Not in scope**: every capability considered and rejected, with the reason, so the next run and the implementing agent do not propose it again.
- **Acceptance**: a checkbox per part, plus `pnpm typecheck` and `pnpm test` passing at the root, and each changed plugin loading after `paseo plugin reload <id>` on a daemon of the new version.

Draft a comment for each unblocked issue (`Unblocked by Paseo <version>: <release link>. Tracked in #<new issue>.`) and each candidate fix (`May be fixed by Paseo <version> (<PR link>); verify before closing. Tracked in #<new issue>.`).
The new issue's number is unknown until it is created; post the comments after it.

When there are no findings, the draft is a marker issue instead: same title format, a body listing the releases reviewed and the "Not in scope" lines, labelled `paseo-release` alone, closed right after creation, so the next run's baseline moves past these releases.

### 6. Post after approval

Show the user the title, labels, body and every comment, and wait for approval; apply what they change.
Then:

```sh
gh label create paseo-release --description "Review of a Paseo release" 2>/dev/null || true
gh issue create --title "<title>" --label paseo-release --label enhancement --label ready-for-agent --body-file <draft>
gh issue comment <number> --body "<comment>"
```

For a marker issue, create it with `--label paseo-release` alone and `gh issue close <number>` it.

### 7. Report

- The baseline, where it came from, and the releases reviewed.
- The issue's URL and the comments posted.
- Findings outside this repository, each with its link and what the user should do about it.
- Any workaround found in code that no package `CLAUDE.md` records.
- The checkout warning from step 0, when there was one.
