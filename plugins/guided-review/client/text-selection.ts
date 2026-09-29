import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform } from "react-native";
import { MAX_QUOTE_LENGTH } from "../shared/drafts.ts";

/** Whether the reviewer can highlight the guide's text to comment on it: a native `Text` reports nothing about what is selected in it. */
export const HIGHLIGHTS_TEXT = Platform.OS === "web";

/** Text the reviewer has selected, trimmed, and the node the selection ends in. */
export type Highlight = { text: string; end: Node };

/**
 * What the reviewer has selected within `ref`'s element: null when nothing is, when the selection
 * reaches outside it, or when it is longer than a comment keeps. Always null off the web.
 * `onRelease` gets it when the reviewer lets go of the mouse having selected some; a touch screen is
 * left out, since the page is not reliably told when a selection's handles are let go.
 */
export function useHighlight(ref: RefObject<unknown>, onRelease?: ((highlight: Highlight) => void) | null): Highlight | null {
  const [selected, setSelected] = useState<Highlight | null>(null);
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
        const highlight = read();
        if (highlight !== null) released.current?.(highlight);
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

function selectedIn(element: Node | null): Highlight | null {
  const selection = document.getSelection();
  if (element === null || selection === null || selection.isCollapsed) return null;
  if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null;
  const text = selection.toString().trim();
  return text === "" || text.length > MAX_QUOTE_LENGTH ? null : { text, end: lastSelected(selection.getRangeAt(0)) };
}

/** The node a selection ends in; one that ends at the very start of a node, as a triple click's does, ends in the node before. */
function lastSelected(range: Range): Node {
  if (range.endOffset > 0 || range.endContainer === range.startContainer) return range.endContainer;
  let node = range.endContainer;
  while (node.previousSibling === null && node.parentNode !== null) node = node.parentNode;
  return node.previousSibling ?? range.endContainer;
}
