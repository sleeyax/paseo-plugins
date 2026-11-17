import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

interface Palette {
  base: string;
  mantle: string;
  text: string;
  subtext0: string;
  overlay0: string;
  surface0: string;
  surface1: string;
  surface2: string;
  mauve: string;
}

interface Flavour {
  id: string;
  name: string;
  appearance: "light" | "dark";
  palette: Palette;
}

const flavours: Flavour[] = [
  {
    id: "latte",
    name: "Catppuccin Latte",
    appearance: "light",
    palette: {
      base: "#eff1f5",
      mantle: "#e6e9ef",
      text: "#4c4f69",
      subtext0: "#6c6f85",
      overlay0: "#9ca0b0",
      surface0: "#ccd0da",
      surface1: "#bcc0cc",
      surface2: "#acb0be",
      mauve: "#8839ef",
    },
  },
  {
    id: "frappe",
    name: "Catppuccin Frappé",
    appearance: "dark",
    palette: {
      base: "#303446",
      mantle: "#292c3c",
      text: "#c6d0f5",
      subtext0: "#a5adce",
      overlay0: "#737994",
      surface0: "#414559",
      surface1: "#51576d",
      surface2: "#626880",
      mauve: "#ca9ee6",
    },
  },
  {
    id: "macchiato",
    name: "Catppuccin Macchiato",
    appearance: "dark",
    palette: {
      base: "#24273a",
      mantle: "#1e2030",
      text: "#cad3f5",
      subtext0: "#a5adcb",
      overlay0: "#6e738d",
      surface0: "#363a4f",
      surface1: "#494d64",
      surface2: "#5b6078",
      mauve: "#c6a0f6",
    },
  },
  {
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    palette: {
      base: "#1e1e2e",
      mantle: "#181825",
      text: "#cdd6f4",
      subtext0: "#a6adc8",
      overlay0: "#6c7086",
      surface0: "#313244",
      surface1: "#45475a",
      surface2: "#585b70",
      mauve: "#cba6f7",
    },
  },
];

function toTheme({ id, name, appearance, palette }: Flavour): PluginThemeContribution {
  return {
    id,
    name,
    appearance,
    colors: {
      background: palette.base,
      foreground: palette.text,
      raised: palette.surface0,
      control: palette.surface1,
      border: palette.surface1,
      accent: palette.mauve,
      mutedForeground: palette.subtext0,
      // Catppuccin's terminal bright black is subtext0 in Latte; in the dark flavours overlay0 keeps the focus outline visible where Catppuccin's surface2 would not be.
      ring: appearance === "light" ? palette.subtext0 : palette.overlay0,
      sidebar: palette.mantle,
      sidebarHover: palette.surface0,
      sidebarSelected: palette.surface1,
      surface3: palette.surface1,
      surface4: palette.surface2,
    },
  };
}

export default function contribute(client: PluginClientContext) {
  for (const flavour of flavours) {
    client.addTheme(toTheme(flavour));
  }
  return () => {};
}
