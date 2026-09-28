# Guided Review

A trunk-first guide to a pull request, with a draft review built alongside it. Paste a GitHub pull request URL, and the plugin prepares a Paseo workspace checked out at the pull request, with a **Guided Review** panel in it.

## Screenshots

## Installation

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/guided-review
```

Paseo tracks the default branch from there, so `paseo plugin update guided-review` picks up new releases without a clone. `paseo plugin status` says what is installed against what is available.

The plugin reads pull requests through [`gh`](https://cli.github.com/), with the login `gh` already has, so run `gh auth login` on the daemon's host first.

To start a review, open the Command Center, choose **Guided Review: start from a pull request URL**, paste the URL and select **Start**. The plugin reads the pull request, creates a workspace checked out at its head, and opens the **Guided Review** panel there with the pull request's title, author, state, file count, additions and deletions. Starting the same pull request again goes back to its workspace while that is open.

In that workspace a guide agent, labelled **Guide: <pull request title>**, reads the pull request and writes the guide, which the panel shows once it is done: the idea behind the change, what you need to know, the decisions the author made with the alternatives they rejected, where to spend your attention, and the change split into concepts. The guide explains; it reports no bugs, risks or style problems and suggests no fixes. While it is being written the panel links the agent, whose chat you can follow. The agent is read-only: it runs in its provider's plan or read-only mode, and the plugin denies every request it makes to edit, write or run a command. Guides are kept per head commit, so reopening the panel shows the stored guide, and archiving the workspace archives the agent.

The workspace is a worktree of a local clone. The plugin uses the Paseo project whose `origin` is the pull request's repository; when there is none, it clones the repository once into `$PASEO_HOME/plugin-data/guided-review/clones/` and reuses that clone for every later review of it.

Requires Paseo 0.9 or newer.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| gh path | `gh` | The `gh` the daemon runs: a command on the daemon's `PATH`, or an absolute path. |
| Guide agent provider and model | `claude` | The agent that writes guides: a provider for its default model, or `provider/model` as Paseo names them, like `codex/gpt-5.5`. Applies to guides generated after the change. |

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| **That is not a GitHub pull request URL** | Paste the pull request's own URL, like `https://github.com/owner/repo/pull/123`. |
| **Could not run gh at "gh"** | The daemon's `PATH` is often shorter than your shell's. Put the output of `command -v gh` in the **gh path** setting. |
| **gh failed: …** | `gh` refused the call; its own words follow. Check `gh auth status` on the daemon's host. |
| **Could not create a workspace for …** | Paseo could not check the pull request out; the reason follows. The worktree is cut from the Paseo project whose `origin` is the pull request's repository. |
| **This review was interrupted before it was ready** | The plugin restarted while preparing the workspace. Start it again. |
| **The guide agent's answer did not match what was asked for: …** | The agent's guide was not in the expected shape; the problems follow. Select **Try again** in the panel, or pick a stronger model in the **Guide agent** setting. |
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
