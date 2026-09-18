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

Each app and plugin has its own README with installation, settings, and development details.

## Local development

Install dependencies and check every package from the repository root:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Enable Paseo plugins, then install each plugin by its directory in this repository:

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/discord-rich-presence
paseo plugin ls
```

Paseo clones the repository itself and tracks the default branch, so `paseo plugin update <id>` and `paseo plugin status` keep an installation current. `claude-tty` is the one that asks something of the host: it runs an adapter that has to be built, so installing and updating it run the `build` commands in its manifest and it needs `pnpm` on the daemon's `PATH` — or a path to an adapter built elsewhere, in its own **Adapter executable** setting.

To work on a plugin, install it from the working copy instead. A directory installation runs no `build`, so build what it needs first:

```sh
paseo plugin add "/absolute/path/to/paseo-plugins/plugins/discord-rich-presence"
```

After making changes, run `paseo plugin reload <id>`. Paseo does not hot-reload plugins, and reloading is the compile check for the client and server bundles built from `index.client.tsx` and `index.server.ts`.

## Releasing a plugin

A plugin's `version` in its own `package.json` is its update identity: [Paseo Cafe](https://github.com/paseo-cafe/paseo-cafe) compares it against the installed copy's, and only a higher version offers an update.
Until it moves, installations stay on the old code however many commits land here.

[release-please](https://github.com/googleapis/release-please) does the bumping, from the conventional commits on `main`: a `feat` takes a minor, a `fix` takes a patch, and a `chore` or `docs` releases nothing.
It keeps a single release pull request open and adds to it as more commits land, so a release can cover one pull request or a batch of them.
Merging it is the release: the new versions and each package's `CHANGELOG.md` are written, tagged, and published as GitHub releases.
Nothing reaches npm, since every package here is private.

Which package a commit bumps comes from the files it touches rather than its scope, so keep a change inside the plugin it belongs to.
`claude-tty` and the `claude-tty-acp` adapter it runs are versioned together, because a change to the adapter changes what the plugin ships.

## Skills

`skills/` holds agent skills for working on this repository, in the [Agent Skills](https://agentskills.io) format, so any harness that reads them can use them.
`.claude/skills/` and `.agents/skills/` are symlinks into it — the first is where Claude Code looks, the second is where Codex, Cursor, OpenCode and GitHub Copilot do — and editing the file under `skills/` updates every harness at once.

| Skill | Description |
| --- | --- |
| `update-plugins` | Rebuild the apps and reload the plugins this host has installed from this checkout. |

Working in this repository needs no installation; the symlinks are committed. To use a skill from another checkout, install it by name:

```sh
npx skills add sleeyax/paseo-plugins --skill update-plugins
```

## Plugin settings

A plugin whose settings the host owns — `registerSettings` in `index.server.ts`, read in a screen `addSettingsScreen` contributes — keeps them in `$PASEO_HOME/plugin-settings/<plugin-id>/<settings-id>.json`, written by the daemon and deleted with the plugin.
A plugin with a store of its own keeps it in `~/.cache/paseo-plugins/<plugin-id>/settings.json`, which nothing cleans up.
