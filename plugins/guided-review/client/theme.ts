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
