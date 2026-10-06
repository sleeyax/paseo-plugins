import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  COLUMN_BOUNDS,
  dragColumn,
  fitColumns,
  handleEdge,
  keepColumnWidths,
  readColumnWidths,
  webStorage,
  type Column,
  type ColumnWidths,
} from "./column-widths.ts";
import type { PanelLayout } from "./guide-entries.ts";
import type { Colors } from "./theme.ts";

/** What a column's handle reports, as offsets from where the press started. */
export type ColumnHandle = {
  edge: "left" | "right";
  start(): void;
  move(offset: number): void;
  end(moved: boolean): void;
  reset(): void;
};

export type ColumnResize = {
  /** The widths to draw the columns at. */
  drawn: ColumnWidths;
  handle(column: Column): ColumnHandle;
};

/**
 * The navigator's and sidebar's widths in `workspaceId`'s panel.
 * Each panel keeps its own, read once when it mounts and written when a drag ends or a column is reset, so resizing one panel leaves every other open panel as it is.
 */
export function useColumnWidths(workspaceId: string, shape: PanelLayout | null, panelWidth: number | null): ColumnResize {
  const [kept, setKept] = useState(() => readColumnWidths(webStorage(), workspaceId));
  const [dragged, setDragged] = useState<ColumnWidths | null>(null);
  const dragStart = useRef<ColumnWidths | null>(null);
  const draggedRef = useRef(dragged);
  draggedRef.current = dragged;
  const wide = shape === "two" || shape === "three" ? shape : null;
  const drawn = dragged ?? (wide !== null && panelWidth !== null ? fitColumns(kept, panelWidth, wide) : kept);

  const keep = (widths: ColumnWidths) => {
    setKept(widths);
    keepColumnWidths(webStorage(), workspaceId, widths);
  };

  return {
    drawn,
    handle(column) {
      const edge = handleEdge(column, wide ?? "two");
      return {
        edge,
        start() {
          dragStart.current = drawn;
        },
        move(offset) {
          const start = dragStart.current;
          if (start === null || wide === null || panelWidth === null) return;
          setDragged(dragColumn(start, column, start[column] + (edge === "right" ? offset : -offset), panelWidth, wide));
        },
        end(moved) {
          const widths = draggedRef.current;
          dragStart.current = null;
          setDragged(null);
          // What is drawn when the drag ends is what is kept, so letting go never moves the other column.
          if (moved && widths !== null) keep(widths);
        },
        reset() {
          keep({ ...kept, [column]: COLUMN_BOUNDS[column].default });
        },
      };
    },
  };
}

/** Paseo's own sidebar handle: a strip straddling the column's border, whose line shows after a short hover. */
const HANDLE_WIDTH = 10;
const HIGHLIGHT_DELAY_MS = 100;

/** Stops a drag from selecting text and a touch drag from scrolling; React Native's style types know neither, nor the cursor. */
const webHandleStyle = { cursor: "col-resize", userSelect: "none", touchAction: "none" } as object;

/** The handle on a column's edge facing the detail pane, dragged to resize the column and double-clicked to reset it. Web only, as the columns are. */
export function ResizeHandle({ control, colors }: { control: ColumnHandle; colors: Colors }) {
  const ref = useRef<View>(null);
  const latest = useRef(control);
  latest.current = control;
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // On the web a view's ref is its DOM element.
    const element = ref.current as unknown as HTMLElement | null;
    if (element === null) return;
    let highlight: ReturnType<typeof setTimeout> | undefined;
    let startX: number | null = null;
    let moved = false;
    const enter = () => {
      clearTimeout(highlight);
      highlight = setTimeout(() => setHovered(true), HIGHLIGHT_DELAY_MS);
    };
    const leave = () => {
      clearTimeout(highlight);
      setHovered(false);
    };
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      startX = event.clientX;
      moved = false;
      setDragging(true);
      latest.current.start();
    };
    const move = (event: PointerEvent) => {
      if (startX === null) return;
      moved ||= event.clientX !== startX;
      latest.current.move(event.clientX - startX);
    };
    const release = () => {
      if (startX === null) return;
      startX = null;
      setDragging(false);
      latest.current.end(moved);
    };
    const reset = () => latest.current.reset();
    const listeners = [
      ["pointerenter", enter],
      ["pointerleave", leave],
      ["pointerdown", press],
      ["pointermove", move],
      ["pointerup", release],
      ["pointercancel", release],
      ["lostpointercapture", release],
      ["dblclick", reset],
    ] as const;
    for (const [type, listener] of listeners) element.addEventListener(type, listener as EventListener);
    return () => {
      clearTimeout(highlight);
      for (const [type, listener] of listeners) element.removeEventListener(type, listener as EventListener);
    };
  }, []);

  const { edge } = control;
  return (
    <View
      ref={ref}
      role="separator"
      style={[{ position: "absolute", top: 0, bottom: 0, width: HANDLE_WIDTH, [edge]: -HANDLE_WIDTH / 2, zIndex: 10 }, webHandleStyle]}
    >
      {hovered || dragging ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            // Over the column's own border, which lies inside the column.
            left: edge === "right" ? HANDLE_WIDTH / 2 - 1 : HANDLE_WIDTH / 2,
            width: 1,
            backgroundColor: colors.foreground,
            opacity: 0.25,
          }}
        />
      ) : null}
    </View>
  );
}
