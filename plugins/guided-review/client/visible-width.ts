import type { LayoutChangeEvent } from "react-native";

/**
 * An `onLayout` handler that reports an element's width only while it is shown.
 * Paseo keeps an inactive tab mounted under `display: none`, which measures 0, and taking that width would draw the narrow layout for a frame when the tab is shown again.
 */
export function onVisibleWidth(setWidth: (width: number) => void) {
  return (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    if (width > 0) setWidth(width);
  };
}
