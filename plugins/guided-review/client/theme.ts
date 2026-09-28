/**
 * Paseo's own design scale, mirrored so what this plugin draws itself measures the same as the host
 * components beside it. The host hands plugins colours but no metrics.
 */
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const fontSize = { sm: 12, base: 14, lg: 16, xl: 20 } as const;
export const radius = { sm: 2, base: 4, md: 6, lg: 8, full: 9999 } as const;

/** Paseo centres its settings screens at this width rather than letting rows span the window. */
export const MAX_CONTENT_WIDTH = 720;

/** Paseo derives every text line height from its font size this way. */
export function leading(size: number): number {
  return Math.round(size * 1.4);
}

/**
 * `color` laid over `base` at `amount`, as an opaque hex colour: the host has no tokens for an added
 * or removed line's background, so they are tints of its status colours. A colour that is not hex
 * or `rgb()` leaves `base` as it is.
 */
export function tint(color: string, base: string, amount: number): string {
  const over = parseRgb(color);
  const under = parseRgb(base);
  if (over === null || under === null) return base;
  const channel = (index: 0 | 1 | 2) =>
    Math.round(under[index] + (over[index] - under[index]) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function parseRgb(value: string): [number, number, number] | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((start) => Number.parseInt(full.slice(start, start + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}
