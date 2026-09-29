import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform } from "react-native";
import { MAX_QUOTE_LENGTH } from "../shared/drafts.ts";

/** Whether the reviewer can highlight the guide's text to comment on it: a native `Text` reports nothing about what is selected in it. */
export const HIGHLIGHTS_TEXT = Platform.OS === "web";

/**
 * The text the reviewer has selected within `ref`'s element, trimmed: null when nothing is, when the
 * selection reaches outside it, or when it is longer than a comment keeps. Always null off the web.
 * `onRelease` gets the text when the reviewer lets go of the mouse having selected some; a touch
 * screen is left out, since the page is not reliably told when a selection's handles are let go.
 */
export function useSelectedText(ref: RefObject<unknown>, onRelease?: ((text: string) => void) | null): string | null {
  const [selected, setSelected] = useState<string | null>(null);
  const released = useRef(onRelease);
  released.current = onRelease;
  useEffect(() => {
    if (!HIGHLIGHTS_TEXT) return;
    // On the web a view's ref is its DOM element.
    const read = () => selectedIn(ref.current as Node | null);
    const change = () => setSelected(read());
    const release = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      // A double or triple click selects its word or paragraph only after its pointerup.
      setTimeout(() => {
        const text = read();
        if (text !== null) released.current?.(text);
      });
    };
    document.addEventListener("selectionchange", change);
    document.addEventListener("pointerup", release);
    return () => {
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("pointerup", release);
    };
  }, [ref]);
  return selected;
}

function selectedIn(element: Node | null): string | null {
  const selection = document.getSelection();
  const inside =
    element !== null &&
    selection !== null &&
    !selection.isCollapsed &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode);
  const text = inside ? selection.toString().trim() : "";
  return text === "" || text.length > MAX_QUOTE_LENGTH ? null : text;
}
