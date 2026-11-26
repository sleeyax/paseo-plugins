import { Platform } from "react-native";

/** The host hands plugins colours but no metrics, so Paseo's scale is restated here. */
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 } as const;
export const fontSize = { sm: 12, base: 14, lg: 16 } as const;
export const radius = { md: 6, lg: 8 } as const;
export const iconSize = { sm: 14, md: 16, lg: 20 } as const;
/** Large enough to hit with a thumb, since running commands from a phone is the main use. */
export const touchTarget = 44;

export const monospace = Platform.select({ ios: "Menlo", default: "monospace" });

export function leading(size: number): number {
  return Math.round(size * 1.4);
}
