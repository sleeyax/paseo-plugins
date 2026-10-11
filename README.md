# Paseo plugins and apps

Extensions for [Paseo](https://github.com/getpaseo/paseo), organized in a pnpm workspace.

| App | Description |
| --- | --- |
| [Claude TTY ACP](apps/claude-tty-acp) | Run genuine interactive Claude Code sessions in Paseo's native agent view. |

| Plugin | Description |
| --- | --- |
| [Discord Rich Presence](plugins/discord-rich-presence) | Show your current Paseo activity on Discord. |
| [Catppuccin theme](plugins/catppuccin-theme) | Add all four Catppuccin flavours as app themes. |
| [Claude TTY](plugins/claude-tty) | Offer the Claude TTY ACP adapter as a Paseo provider, and manage it on the daemon host. |
| [Guided Review](plugins/guided-review) | Show a trunk-first guide to a pull request or merge request, and build your draft review alongside it. |

Each app and plugin has its own README.

## Installation

Enable plugins in Paseo, then install a plugin by its directory in this repository:

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/discord-rich-presence
```

Plugins in the [Paseo plugin registry](https://paseo.sh/plugins) also install by their registry ID, which their README gives.
Update with `paseo plugin update <id>`, or preview the update with `paseo plugin update <id> --check`.

`claude-tty` and `guided-review` run a `pnpm` build when installed or updated, so they need `pnpm` on the daemon's `PATH`.

Plugins keep their settings in `$PASEO_HOME/plugin-settings/<plugin-id>/`.
Paseo manages that directory and removes it with the plugin.

## Local development

Install dependencies and check every package from the repository root:

```sh
pnpm install
pnpm typecheck
pnpm test
```

To work on a plugin, install it from your working copy.
A directory installation runs no build, so build what the plugin needs first:

```sh
paseo plugin add "/absolute/path/to/paseo-plugins/plugins/discord-rich-presence"
```

Paseo does not hot-reload plugins.
Run `paseo plugin reload <id>` after each change; the reload is also what compiles the plugin's bundles.

## Releasing a plugin

[release-please](https://github.com/googleapis/release-please) releases from the conventional commits on `main`: a `feat` bumps the minor version, a `fix` the patch version, and `chore` or `docs` release nothing.
It keeps one release pull request open, and merging it is the release: versions, `CHANGELOG.md` files, tags and GitHub releases.

A plugin's `version` in its `package.json` is what [Paseo Cafe](https://github.com/paseo-cafe/paseo-cafe) compares to offer an update, so installations only move when the version does.
release-please picks the package to bump from the files a commit touches, not its scope, so keep each commit inside one package.
`claude-tty` and `claude-tty-acp` share one version.

## Skills

`skills/` holds agent skills for working on this repository, in the [Agent Skills](https://agentskills.io) format.
`.claude/skills/` (Claude Code) and `.agents/skills/` (Codex, Cursor, OpenCode, GitHub Copilot) are committed symlinks into it, so edit the files under `skills/`.

| Skill | Description |
| --- | --- |
| `update-plugins` | Rebuild the apps and reload the plugins this host has installed from this checkout. |
| `adopt-paseo-release` | Review the Paseo releases since the last review and file an issue with what the plugins should adopt. Runs only when invoked by name: `/adopt-paseo-release` in Claude Code, `$adopt-paseo-release` in Codex. |

To use a skill from another checkout, install it by name:

```sh
npx skills add sleeyax/paseo-plugins --skill update-plugins
```
