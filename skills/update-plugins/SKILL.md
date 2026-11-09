---
name: update-plugins
description: Rebuild and reload the paseo plugins installed on this host from the sleeyax/paseo-plugins checkout, including the apps under apps/ that a directory install never builds. Use when the user asks to update, rebuild, reinstall, or reload the paseo plugins they have installed from this repo.
---

# Update the plugins installed from this repo

Every plugin in this repository is installed against its own directory, so the daemon runs these files directly.
"Update" therefore means: get the working copy current, then run `scripts/rebuild-plugins.sh`, which runs the builds a directory install never runs itself and reloads each plugin so the daemon recompiles its bundles.

## Hard rules

- **Keep git to a fast-forward pull.** If the pull does not apply cleanly under the conditions below, skip it and rebuild the working copy as it stands.
- **Report failures with their output.** A build that fails, a plugin that comes back `error`: say so and quote the error.

## Steps

### 0. Confirm this is the right checkout

This skill can be installed globally, so it cannot assume where it is running.

```sh
git rev-parse --show-toplevel 2>/dev/null
```

The repository root must contain `pnpm-workspace.yaml` and a `plugins/` directory holding `paseo-plugin.json` manifests.
If it does not, this is not the paseo-plugins checkout: say so and stop.
Everything below runs from that root.

### 1. Pull, but only when it is free

Pull only when all three hold: the working tree is clean, `HEAD` is the default branch, and it has an upstream.

```sh
git pull --ff-only
```

Otherwise skip it and name the reason in one clause: dirty tree, on a branch, no upstream.
A skipped pull is not an error; the rebuild still runs against what is checked out.

### 2. Rebuild and reload

```sh
scripts/rebuild-plugins.sh
```

The script covers every plugin the daemon runs from this checkout, and a non-zero exit means something failed.
Read its output for the three cases below.

If `--frozen-lockfile` failed, the lockfile is behind `package.json`, which is a problem to report, because a plain `pnpm install` would change the lockfile the daemon installs from.

A plugin in `paseo plugin ls` whose `SOURCE` is `git` runs from the daemon's own clone, so nothing local reaches it and the script leaves it out.
`paseo plugin update <id>` is its whole update.

A line starting `Skipped reload of <id>` means that plugin's provider hosts this session, and a reload would end it.
Type the reload into a terminal of this workspace without pressing Enter, so the user runs it once they are done with the session:

```sh
workspace=$(jq -r .workspaceId "${PASEO_HOME:-$HOME/.paseo}"/agents/*/"$PASEO_AGENT_ID".json)
terminal=$(paseo terminal create --workspace "$workspace" --cwd "$PWD" --name "reload <id>" -q)
paseo terminal send-keys --literal "$terminal" 'paseo plugin reload <id> --json'
```

Pass the workspace rather than relying on `--cwd`: given a directory alone, the daemon picks one of the workspaces open on it, and with several open on this checkout that is often not the user's.
Address the terminal by the ID `create` prints, since a name can match a leftover terminal from an earlier run.
The daemon owns that terminal, so it outlives the sessions the reload closes.

### 3. Report

One short summary:

- Whether the pull ran, and the commit range it brought in, or why it was skipped.
- Each plugin reloaded, with its status.
- Anything that failed, with the error.
- When a plugin was skipped because it hosts this session, end by pointing the user at the `reload <id>` terminal, and say that pressing Enter there closes this session.

When `claude-tty` was among them, add the one caveat that is not visible from the status: an adapter process keeps the code it started with, so the rebuilt adapter reaches only sessions started after the reload.
Existing sessions carry the old one until they are restarted.
Its adapter log is `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`, separate from the plugin's own `paseo plugin logs claude-tty`, because the daemon drops the adapter's stderr.
