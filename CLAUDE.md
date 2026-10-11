# Working in this workspace

A pnpm workspace of paseo plugins, one per directory under `plugins/`.
Each package is a plugin directory in its own right: paseo is installed against `plugins/<name>`, and `paseo-plugin.json` and the runtime entries sit at that package's root because the loader stats exactly those names.
Since Paseo 0.8 those entries are `index.client.tsx` and `index.server.ts`, either or both, and every other module lives under `client/`, `server/`, or `shared/`, which is what decides the bundle it joins.

Dependencies belong to the package that uses them, not the root, because the daemon's esbuild resolves from the plugin directory.
`pnpm typecheck` and `pnpm test` at the root fan out to every package; the package-level scripts are the ones to run while working on a single plugin.

Paseo documents the plugin contract at `public-docs/plugins/reference.md` in `getpaseo/paseo`: which modules each runtime may import, the settings store, the theme tokens, the host UI components, and the CLI.
`providers.md` beside it covers ACP providers, `publishing.md` npm distribution, and `migration.md` the runtime-entry migration.
Read it before inferring a rule from a failed build.
Each package carries its own CLAUDE.md, which records only what that reference does not.

## Plugin READMEs

Every plugin's README follows the same template, so a new plugin starts from this and drops only the sections marked optional:

```md
# plugin name

<short description>

## Screenshots

## Installation

<paseo plugin add sleeyax/<name> for a plugin in the Paseo registry, else paseo plugin add github:sleeyax/paseo-plugins:plugins/<name>, plus the update note; a plugin that needs a built artefact from this repo documents the absolute-path form instead>

<optional extra instructions>

## Settings

## Troubleshooting (optional)

## Development

<instructions for developers>

## License and attributions (optional)
```

Where a plugin's settings file lives is documented once in the root README, not per plugin.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on sleeyax/paseo-plugins, managed with the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each label string equal to its role name.
See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `GLOSSARY-MAP.md` points at one `GLOSSARY.md` per plugin or app, and `docs/adr/` at the root holds workspace-wide decisions.
See `docs/agents/domain.md`.
