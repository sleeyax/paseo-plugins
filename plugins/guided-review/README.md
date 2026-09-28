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

In that workspace a guide agent, labelled **Guide: <title>**, reads the pull request or merge request and writes the guide, which the panel shows once it is done: the idea behind the change, what you need to know, the decisions the author made with the alternatives they rejected, where to spend your attention, and the change split into concepts. Each concept shows the code it covers: the hunks of each file it names, or the lines within a hunk when a hunk holds more than one concept, with old and new line numbers and added and removed lines coloured. The guide explains; it reports no bugs, risks or style problems and suggests no fixes. While it is being written the panel links the agent, whose chat you can follow. The agent is read-only: it runs in its provider's plan or read-only mode, and the plugin denies every request it makes to edit, write or run a command. Guides are kept per head commit, so reopening the panel shows the stored guide, and archiving the workspace archives the agent.

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
| **This review was interrupted before it was ready** | The plugin restarted while preparing the workspace. Start it again. |
| **The guide agent's answer did not match what was asked for: …** | The agent's guide was not in the expected shape, or named code the change does not have; the problems follow. Select **Try again** in the panel, or pick a stronger model in the **Guide agent** setting. |
| **The … provider offers no model for the guide agent** or **Could not create the guide agent with …** | Check the **Guide agent** setting against the providers and models Paseo lists for new agents. |
| **The guide agent did not finish within 30 minutes** | Open the guide agent to see where it got stuck, then select **Try again**. |

Run `paseo plugin logs guided-review` for more detail.

## Development

```sh
pnpm typecheck
pnpm test
paseo plugin reload guided-review
paseo plugin logs guided-review
```

Paseo builds the app bundle from `index.client.tsx` and the daemon bundle from `index.server.ts`. A module's directory decides which it joins: `client/` the app's, `server/` the daemon's, `shared/` both.
