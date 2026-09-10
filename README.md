# Paseo plugins and apps

Extensions for [Paseo](https://github.com/getpaseo/paseo), organized in a pnpm workspace.

| App | Description |
| --- | --- |
| [Claude TTY ACP](apps/claude-tty-acp) | Run genuine interactive Claude Code sessions in Paseo's native agent view. |

| Plugin | Description |
| --- | --- |
| [Discord Rich Presence](plugins/discord-rich-presence) | Show your current Paseo activity on Discord. |
| [Catppuccin theme](plugins/catppuccin-theme) | Add all four Catppuccin flavours as app themes. |
| [Claude TTY](plugins/claude-tty) | Install, diagnose, and manage the Claude TTY ACP adapter on the daemon host. |

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

Paseo clones the repository itself and tracks the default branch, so `paseo plugin update <id>` and `paseo plugin status` keep an installation current. `claude-tty` is the exception: it manages the adapter in the checkout it was installed from and that adapter has to be built, which a Git installation never does, so it is installed from a clone by absolute path.

To work on a plugin, install it from the working copy instead:

```sh
paseo plugin install "/absolute/path/to/paseo-plugins/plugins/discord-rich-presence"
```

After making changes, run `paseo plugin reload <id>`. Paseo does not hot-reload plugins, and reloading is the compile check for the client and server bundles built from `index.client.tsx` and `index.server.ts`.

## Plugin settings

Plugin settings are stored in `~/.cache/paseo-plugins/<plugin-id>/settings.json`.
