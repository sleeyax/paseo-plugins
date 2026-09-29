import { useEffect, useState, type RefObject } from "react";
import { Platform } from "react-native";
import { MAX_QUOTE_LENGTH } from "../shared/drafts.ts";

/** Whether the reviewer can highlight the guide's text to comment on it: a native `Text` reports nothing about what is selected in it. */
export const HIGHLIGHTS_TEXT = Platform.OS === "web";

/**
 * The text the reviewer has selected within `ref`'s element, trimmed: null when nothing is, when the
 * selection reaches outside it, or when it is longer than a comment keeps. Always null off the web.
 */
export function useSelectedText(ref: RefObject<unknown>): string | null {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!HIGHLIGHTS_TEXT) return;
    const read = () => {
      // On the web a view's ref is its DOM element.
      const element = ref.current as Node | null;
      const selection = document.getSelection();
      const inside =
        element !== null &&
        selection !== null &&
        !selection.isCollapsed &&
        element.contains(selection.anchorNode) &&
        element.contains(selection.focusNode);
      const text = inside ? selection.toString().trim() : "";
      setSelected(text === "" || text.length > MAX_QUOTE_LENGTH ? null : text);
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [ref]);
  return selected;
}
