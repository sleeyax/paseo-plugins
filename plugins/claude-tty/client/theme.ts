import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Paseo's own design scale, mirrored so the panel measures the same as the settings screens it sits
 * beside. The host hands plugins colors but no metrics, so the scale has to be restated here.
 */
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const fontSize = { sm: 12, base: 14, lg: 16 } as const;
export const radius = { sm: 2, base: 4, md: 6, lg: 8, xl: 12, full: 9999 } as const;
export const controlHeight = { tight: 28, compact: 32, field: 44 } as const;
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20 } as const;

/** Paseo centres its settings screens at this width rather than letting rows span the window. */
export const MAX_CONTENT_WIDTH = 720;

const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const THUMB_SIZE = 16;

export const switchGeometry = {
  trackWidth: TRACK_WIDTH,
  trackHeight: TRACK_HEIGHT,
  thumbSize: THUMB_SIZE,
  thumbTravel: TRACK_WIDTH - THUMB_SIZE - (TRACK_HEIGHT - THUMB_SIZE),
} as const;

/** Paseo derives every text line height from its font size this way. */
export function leading(size: number): number {
  return Math.round(size * 1.4);
}

export type Palette = {
  isDark: boolean;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  border: string;
  borderAccent: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  accent: string;
  accentForeground: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
};

type Rgb = { r: number; g: number; b: number };

/**
 * The shades paseo keeps above the ramp it exposes, measured off its own themes. surface3 is a
 * fraction of the way from surface2 to white on a dark theme and to black on a light one, and
 * surface4 is that step again from surface3.
 * borderAccent is measured from surface0 instead, because on a light theme it sits lighter than
 * border rather than darker, so it cannot be a step in the same direction.
 */
const DARK_RAMP = { surface3: 0.12, surface4: 0.11, borderAccent: 0.1 };
const LIGHT_RAMP = { surface3: 0.065, surface4: 0.07, borderAccent: 0.075 };

export function parseColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = text.startsWith("#") ? text.slice(1) : null;
  if (hex !== null && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const width = hex.length === 3 ? 1 : 2;
    const channel = (index: number) => {
      const part = hex.slice(index * width, index * width + width);
      const parsed = Number.parseInt(width === 1 ? part + part : part, 16);
      return Number.isNaN(parsed) ? null : parsed;
    };
    const r = channel(0);
    const g = channel(1);
    const b = channel(2);
    return r === null || g === null || b === null ? null : { r, g, b };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter((part) => part !== "");
    const [r, g, b] = parts.map((part) => Number.parseFloat(part));
    if ([r, g, b].some((part) => part === undefined || Number.isNaN(part))) return null;
    return { r: r!, g: g!, b: b! };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

export function isDarkColor({ r, g, b }: Rgb): boolean {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** A translucent version of a color, for tints that have to sit over content rather than replace it. */
export function alpha(value: string, amount: number): string {
  const rgb = parseColor(value);
  if (rgb === null) return value;
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${amount})`;
}

/**
 * Adds the shades paseo's components are written against but does not expose, so a plugin surface
 * and a built-in screen land on the same colors instead of on stacked translucent overlays.
 */
export function derivePalette(theme: PluginTheme): Palette {
  const colors = theme.colors;
  const base = parseColor(colors.surface0);
  const raised = parseColor(colors.surface2);
  const muted = parseColor(colors.foregroundMuted);

  const host = {
    surface0: colors.surface0,
    surface1: colors.surface1,
    surface2: colors.surface2,
    border: colors.border,
    foreground: colors.foreground,
    foregroundMuted: colors.foregroundMuted,
    accent: colors.accent,
    accentForeground: colors.accentForeground,
    statusSuccess: colors.statusSuccess,
    statusWarning: colors.statusWarning,
    statusDanger: colors.statusDanger,
  };

  /** Either surface answers this, so only a theme with neither readable has to be assumed dark. */
  const isDark = isDarkColor(base ?? raised ?? { r: 0, g: 0, b: 0 });

  if (base === null || raised === null) {
    return {
      ...host,
      isDark,
      surface3: colors.surface2,
      surface4: colors.surface2,
      borderAccent: colors.border,
      foregroundExtraMuted: colors.foregroundMuted,
    };
  }

  const ramp = isDark ? DARK_RAMP : LIGHT_RAMP;
  const target: Rgb = isDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const surface3 = mix(raised, target, ramp.surface3);

  return {
    ...host,
    isDark,
    surface3: toHex(surface3),
    surface4: toHex(mix(surface3, target, ramp.surface4)),
    borderAccent: toHex(mix(base, target, ramp.borderAccent)),
    foregroundExtraMuted: muted === null ? colors.foregroundMuted : toHex(mix(muted, base, 0.35)),
  };
}
