# Guided Review

A trunk-first guide to a pull request, with a draft review built alongside it. Paste a GitHub pull request or GitLab merge request URL, and the plugin prepares a Paseo workspace checked out at it, with a **Guided Review** panel in it.

## Screenshots

## Installation

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/guided-review
```

Paseo tracks the default branch from there, so `paseo plugin update guided-review` picks up new releases without a clone. `paseo plugin status` says what is installed against what is available.

The plugin reads pull requests through [`gh`](https://cli.github.com/) and merge requests through [`glab`](https://gitlab.com/gitlab-org/cli), with the logins they already have, so run `gh auth login` or `glab auth login` on the daemon's host first. GitLab works on gitlab.com and on any self-hosted host `glab` is logged in to; the plugin checks with `glab auth status --hostname <host>` before it calls a host, and turns down a merge request URL on any other.

The plugin runs `glab` without `PASEO_AGENT_ID` and `GITLAB_BOT_IDENTITY` in its environment, so a `glab` wrapper that switches to a bot account for agents still reads and reviews as you.

To start a review, open the Command Center, choose **Guided Review: start from a PR or MR URL**, paste the URL and select **Start**. The plugin reads the pull request or merge request, creates a workspace checked out at its head, and opens the **Guided Review** panel there with its title, author, state, file count, additions and deletions. Starting the same one again goes back to its workspace while that is open.

To guide the branch you are already on, open the Command Center in its workspace and choose **Guided Review: guide this branch's PR/MR**, or select **Guide this branch's PR/MR** in an empty **Guided Review** panel. The plugin reads the workspace's branch and `origin` with `git`, finds the open pull request or merge request whose source branch it is, and offers a choice when there are several. When the working tree is clean and the branch has no commits the pull request or merge request lacks, the plugin fetches its head and fast-forwards the branch to it (`git merge --ff-only`), and the guide lives in that workspace. A branch with uncommitted changes, untracked files included, or one that has diverged is never touched: the panel says why in one line, and the guide goes to a new workspace checked out at the head, which the panel links.

In that workspace a guide agent, labelled **Guide: <title>**, reads the pull request or merge request and writes the guide, which the panel shows once it is done: the idea behind the change, what you need to know, the decisions the author made with the alternatives they rejected, where to spend your attention, and the change split into concepts. Each concept shows the code it covers: the hunks of each file it names, or the lines within a hunk when a hunk holds more than one concept, with old and new line numbers and added and removed lines coloured. The guide explains; it reports no bugs, risks or style problems and suggests no fixes. While it is being written the panel links the agent, whose chat you can follow. The agent is read-only: it runs in its provider's plan or read-only mode, and the plugin denies every request it makes to edit, write or run a command. Guides are kept per head commit, so reopening the panel shows the stored guide, and archiving the workspace archives the agent.

The concepts are shown in layers, foundations first: each concept names the concepts it builds on and why, and a concept in a later layer builds only on earlier ones, in three layers at most. Leaf concepts, which nothing builds on, are drawn lighter than the foundations, since they tend to follow a pattern already explained. Tests, docs and pure wiring sit in a **Supporting** group outside the layers, and so do lockfiles and generated files, which the plugin recognises by their paths and never shows the agent, so a large change stays within its reach. Every changed file is covered by at least one concept, in Supporting, or in an **Unsorted** group that lists the files the agent placed nowhere, so nothing in the change is skipped silently. Each Supporting and Unsorted file shows its whole diff under it, so tests and wiring can be read where they are listed; lockfiles and generated files start with theirs hidden behind **Show the diff**.

To dig into a concept, select **Ask about this** on it. The plugin sends the guide agent a prompt naming the concept, with what the guide says about it, and opens the agent's chat, where you carry on the conversation. Each file in Supporting and Unsorted has its own **Ask about this**, which names the file, how it changed and where the guide put it. The agent answers only when it is idle, since a new prompt would cut off the answer it is writing; while it is busy the panel says so, and you ask again once it has finished.

To keep your place in a large review, select **Mark understood** on each concept, and on each file in Supporting and Unsorted, once you have read it; selecting it again takes the mark back. Above the concepts the panel shows how much you have understood overall, in each layer from the foundations up, and in Supporting and Unsorted, and names the next layer to read, so you can see whether the foundations are covered before moving on. Your marks are kept on disk per head commit and survive Paseo restarts. A guide generated again, after **Try again** or in a new workspace, starts with none, since its concepts may be split differently.

When new commits are pushed after the guide was written, the panel shows **PR updated since this guide** (**MR updated** on GitLab), which it checks for when it opens and every minute while it is open. Nothing is regenerated on its own, so the guide never changes while you read it, and starting the review again keeps the guide and its workspace where they are. Select **Regenerate** to move on: the plugin reads the pull request or merge request at its new head, fast-forwards the guide's workspace to it the same way as your own branch, and has a new guide agent write a guide for that head, which the panel then shows. The concepts you marked understood stay marked where a concept of the new guide covers exactly the same code, whatever it is called and wherever the push moved its lines, and so do Supporting and Unsorted files whose diff did not change; everything else starts unmarked. A workspace that cannot be fast-forwarded, because it has uncommitted changes or the branch was force-pushed, is left untouched, and the new guide goes to a new workspace checked out at the head, which the panel opens.

The workspace is a worktree of a local clone. The plugin uses the Paseo project whose `origin` is the repository the pull request or merge request targets; when there is none, it clones the repository once with `gh repo clone` or `glab repo clone` into `$PASEO_HOME/plugin-data/guided-review/clones/` and reuses that clone for every later review of it.

Requires Paseo 0.9 or newer.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| gh path | `gh` | The `gh` the daemon runs: a command on the daemon's `PATH`, or an absolute path. |
| glab path | `glab` | The `glab` the daemon runs, read the same way. |
| Guide agent provider and model | `claude` | The agent that writes guides: a provider for its default model, or `provider/model` as Paseo names them, like `codex/gpt-5.5`. Applies to guides generated after the change. |

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| **That is not a GitHub pull request URL, …** | Paste the pull request's or merge request's own URL, like `https://github.com/owner/repo/pull/123` or `https://gitlab.com/group/project/-/merge_requests/123`. |
| **glab is not logged in to …** | Run `glab auth login --hostname <host>` on the daemon's host. A self-hosted GitLab on a port needs that host set up in `glab`'s own config. |
| **Could not run gh at "gh"** or **Could not run glab at "glab"** | The daemon's `PATH` is often shorter than your shell's. Put the output of `command -v gh` or `command -v glab` in the matching path setting. |
| **gh failed: …** or **glab failed: …** | The CLI refused the call; its own words follow. Check `gh auth status` or `glab auth status` on the daemon's host. |
| **Could not create a workspace for …** | Paseo could not check the pull request or merge request out; the reason follows. The worktree is cut from the Paseo project whose `origin` is its repository. |
| **No open pull request in … comes from …** | The workspace's branch is not the source branch of an open pull request or merge request in its `origin` repository. Push it and open one, or start from the URL. |
| **… has uncommitted changes, so it was left untouched** or **… has commits that are not in …** | Commit, stash or push your work, then guide the branch again to have the guide in your own workspace; until then it is in the PR workspace. |
| **The previous PR workspace has uncommitted changes** or **… has commits that are not in … any more** | **Regenerate** could not fast-forward the old workspace to the new head, so the guide moved to a new one. Archive the old workspace once you no longer need it. |
| No **PR updated since this guide** banner though commits were pushed | The forge could not be asked where the head is, and the panel shows no banner until it can; `paseo plugin logs guided-review` has **Could not check … for new commits** with the CLI's own words. GitLab shows a push once it has worked out the new diff, a moment after it. |
| **This review was interrupted before it was ready** | The plugin restarted while preparing the workspace. Start it again. |
| **The guide agent's answer did not match what was asked for: …** | The agent's guide was not in the expected shape, or named code the change does not have; the problems follow. Select **Try again** in the panel, or pick a stronger model in the **Guide agent** setting. |
| **The … provider offers no model for the guide agent** or **Could not create the guide agent with …** | Check the **Guide agent** setting against the providers and models Paseo lists for new agents. |
| **The guide agent did not finish within 30 minutes** | Open the guide agent to see where it got stuck, then select **Try again**. |
| **The guide agent is busy with another answer** | It is still answering an earlier question. Open its chat to follow it, and ask again once it has finished. |
| **The guide agent is gone: it was archived or closed** | The guide has no agent left to answer questions; its chat was archived or closed. |

Run `paseo plugin logs guided-review` for more detail.

## Development

```sh
pnpm typecheck
pnpm test
paseo plugin reload guided-review
paseo plugin logs guided-review
```

Paseo builds the app bundle from `index.client.tsx` and the daemon bundle from `index.server.ts`. A module's directory decides which it joins: `client/` the app's, `server/` the daemon's, `shared/` both.
