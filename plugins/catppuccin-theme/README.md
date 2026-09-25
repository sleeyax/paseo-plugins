# Catppuccin theme

Adds all [Catppuccin](https://catppuccin.com/palette/) flavours — Latte, Frappé, Macchiato, and Mocha — as Paseo app themes.

## Screenshots

_None yet._

## Installation

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/catppuccin-theme
```

Then pick your favorite theme in **Settings -> Appearance**.

Paseo tracks the default branch from there, so `paseo plugin update catppuccin-theme` picks up new releases without a clone. `paseo plugin status` says what is installed against what is available.

## Settings

The plugin has no settings. Change the theme in Settings -> Appearance.

## Development

```sh
paseo plugin reload catppuccin-theme
paseo plugin logs catppuccin-theme
```

Each flavour maps the same seven palette colours onto Paseo's theme tokens.

## License and attributions

The palettes comes from [Catppuccin](https://github.com/catppuccin/catppuccin), licensed under the MIT License.
