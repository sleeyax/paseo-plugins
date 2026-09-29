import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform } from "react-native";

/** Whether the reviewer can highlight the guide's text to comment on it: a native `Text` reports nothing about what is selected in it. */
export const HIGHLIGHTS_TEXT = Platform.OS === "web";

/** Text the reviewer has selected, trimmed, and the node the selection ends in. */
export type Highlight = { text: string; end: Node };

export type HighlightOptions = {
  /**
   * Gets the highlight when the reviewer lets go of the mouse having selected some, pressed inside
   * the element; a touch screen is left out, since the page is not reliably told when a selection's
   * handles are let go.
   */
  onRelease?: ((highlight: Highlight) => void) | null;
  /** Parts of the element that are not its text, such as comment boxes drawn in it, which a highlight may not touch. */
  excluded?: () => Iterable<Node>;
};

/**
 * What the reviewer has selected within `ref`'s element: null when nothing is, or when the
 * selection reaches outside it or into an excluded part. Always null off the web.
 */
export function useHighlight(ref: RefObject<unknown>, options: HighlightOptions = {}): Highlight | null {
  const [selected, setSelected] = useState<Highlight | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!HIGHLIGHTS_TEXT) return;
    // On the web a view's ref is its DOM element.
    const element = () => ref.current as Node | null;
    const excluded = () => [...(latest.current.excluded?.() ?? [])];
    const read = () => selectedIn(element(), excluded());
    const change = () => setSelected(read());
    let pressedInText = false;
    const press = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const prose = element();
      pressedInText =
        event.pointerType === "mouse" && target !== null && prose !== null && prose.contains(target) && !excluded().some((part) => part.contains(target));
    };
    const release = () => {
      if (!pressedInText) return;
      pressedInText = false;
      // A double or triple click selects its word or paragraph only after its pointerup.
      setTimeout(() => {
        trimEnd();
        const highlight = read();
        if (highlight !== null) latest.current.onRelease?.(highlight);
      });
    };
    document.addEventListener("selectionchange", change);
    document.addEventListener("pointerdown", press);
    document.addEventListener("pointerup", release);
    return () => {
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("pointerup", release);
    };
  }, [ref]);
  return selected;
}

function selectedIn(element: Node | null, excluded: readonly Node[]): Highlight | null {
  const selection = document.getSelection();
  if (element === null || selection === null || selection.isCollapsed) return null;
  if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  if (excluded.some((part) => range.intersectsNode(part))) return null;
  const text = selection.toString().trim();
  return text === "" ? null : { text, end: lastSelected(range) };
}

/** The node a selection ends in; one that ends at the very start of a node, as a triple click's does, ends in the node before. */
function lastSelected(range: Range): Node {
  if (range.endOffset > 0 || range.endContainer === range.startContainer) return range.endContainer;
  let node = range.endContainer;
  while (node.previousSibling === null && node.parentNode !== null) node = node.parentNode;
  return node.previousSibling ?? range.endContainer;
}

/** Ends a selection that runs to the start of the node after it at the end of the node it covers, so a comment box drawn between them is not in it. */
function trimEnd(): void {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const last = lastSelected(range);
  if (last === range.endContainer) return;
  const end = last.nodeType === Node.TEXT_NODE ? (last as Text).length : last.childNodes.length;
  selection.setBaseAndExtent(range.startContainer, range.startOffset, last, end);
}
