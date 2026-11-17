# Working on this plugin

Run `paseo plugin reload catppuccin-theme` after every change; it is the only compile check of the client bundle.
Do this yourself rather than leaving it to the user.

The plugin maps each flavour's palette to theme colours in `toTheme` in `index.client.ts` and has no server entry.

## Theme tokens

- The host parses a contribution strictly, so an unknown key is rejected, not ignored.
  An app older than 0.16.0 rejects the sidebar and surface colours that way, and the plugin's other contributions with them, so `requirements.paseo` stays at `>=0.16.0` while any are set.
- `statusSuccess` and `statusWarning` exist on `PluginTheme`, which a plugin receives, not on the contribution. Fix a clash with the app's status colours by picking a different palette colour for one of ours.
- Leave `foregroundExtraMuted` out.
  Paseo uses an explicit one unchanged as the text on hovered and selected sidebar rows, where overlay1 falls under 2.5:1 in every flavour; derived, it lands within a few RGB units of overlay1 and is raised to 2.5:1 on those rows.
