# Working on this plugin

Run `paseo plugin reload catppuccin-theme` after every change.
The reload is the only compile check of the bundle the daemon builds from `index.client.ts`.
Do this yourself; never leave it to the user.

The plugin is nothing but data: four `addTheme` calls, no surface and no `server.handle`, so there is no server entry and nothing to test beyond `pnpm typecheck`.
`PluginThemeColors` is the eight tokens Paseo expands into its own set, and the host parses a contribution with a Zod `strictObject`, so a ninth key is rejected rather than ignored.
v0.7 added `statusSuccess` and `statusWarning` to `PluginTheme` — what a plugin *receives* — and not to the contribution, so a mismatch with the app is still fixed by choosing a different palette colour for one of the eight.
Paseo expands a contribution by reading `border` as its `surface3` and `ring` as its `surface4` and `foregroundExtraMuted`, which is what those two are really choosing.
Every flavour uses the same palette-to-token mapping, so a fix to one belongs in all four.
