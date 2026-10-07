import { z } from "zod";
import { PLUGIN_ID } from "../shared/identity.ts";

/** The Guide navigator, left of the detail pane in the three-column layout, and the sidebar, right of it there and the whole left column in the two-column one. */
export type Column = "navigator" | "sidebar";
export type ColumnWidths = Record<Column, number>;
export type WideLayout = "two" | "three";

/** The navigator is wide enough for a concept's title, the sidebar for a draft card's text and the progress bars, and each leaves the detail pane room for a diff. */
export const COLUMN_BOUNDS: Record<Column, { min: number; default: number; max: number }> = {
  navigator: { min: 200, default: 280, max: 480 },
  sidebar: { min: 280, default: 360, max: 600 },
};

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { navigator: COLUMN_BOUNDS.navigator.default, sidebar: COLUMN_BOUNDS.sidebar.default };

/** The narrowest the detail pane is drawn while a column is beside it. */
export const MIN_DETAIL_WIDTH = 480;

/** How many workspaces keep their widths; the least recently resized beyond it are forgotten. */
export const REMEMBERED_WORKSPACES = 100;

/** The edge of a column its handle sits on, the one facing the detail pane. */
export function handleEdge(column: Column, shape: WideLayout): "left" | "right" {
  return column === "sidebar" && shape === "three" ? "left" : "right";
}

/**
 * The widths a panel `panelWidth` wide draws its columns at.
 * Each is kept within its bounds, and where two leave the detail pane too little they give it back in proportion to their widths, so widening the window again restores them as they were set.
 */
export function fitColumns(widths: ColumnWidths, panelWidth: number, shape: WideLayout): ColumnWidths {
  const navigator = withinBounds("navigator", widths.navigator);
  const sidebar = withinBounds("sidebar", widths.sidebar);
  const room = panelWidth - MIN_DETAIL_WIDTH;
  if (shape === "two") return { navigator, sidebar: Math.max(COLUMN_BOUNDS.sidebar.min, Math.min(sidebar, room)) };
  if (navigator + sidebar <= room) return { navigator, sidebar };
  const scale = room / (navigator + sidebar);
  const fittedSidebar = Math.max(COLUMN_BOUNDS.sidebar.min, room - Math.max(COLUMN_BOUNDS.navigator.min, Math.round(navigator * scale)));
  return { navigator: Math.max(COLUMN_BOUNDS.navigator.min, room - fittedSidebar), sidebar: fittedSidebar };
}

/** The widths after dragging `column`'s handle to make it `requested` wide, from the `drawn` widths the drag started at: the other column stays as drawn, and the detail pane keeps its minimum. */
export function dragColumn(drawn: ColumnWidths, column: Column, requested: number, panelWidth: number, shape: WideLayout): ColumnWidths {
  const beside = shape === "three" ? drawn[column === "navigator" ? "sidebar" : "navigator"] : 0;
  const room = panelWidth - MIN_DETAIL_WIDTH - beside;
  return { ...drawn, [column]: Math.max(COLUMN_BOUNDS[column].min, Math.min(withinBounds(column, requested), room)) };
}

function withinBounds(column: Column, width: number): number {
  const { min, max } = COLUMN_BOUNDS[column];
  return Math.round(Math.min(max, Math.max(min, width)));
}

export type WidthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY = `${PLUGIN_ID}.column-widths`;

/** Most recently resized first. */
const StoredWidthsSchema = z.array(z.object({ workspaceId: z.string(), navigator: z.number(), sidebar: z.number() })).catch([]);

/** The widths `workspaceId`'s panel was last resized to, or the defaults. */
export function readColumnWidths(storage: WidthStorage | null, workspaceId: string): ColumnWidths {
  const entry = readStored(storage).find((stored) => stored.workspaceId === workspaceId);
  return entry ? { navigator: entry.navigator, sidebar: entry.sidebar } : DEFAULT_COLUMN_WIDTHS;
}

/** Remembers `widths` for `workspaceId`'s panel, or forgets it when they are the defaults. */
export function keepColumnWidths(storage: WidthStorage | null, workspaceId: string, widths: ColumnWidths): void {
  if (storage === null) return;
  const others = readStored(storage).filter((stored) => stored.workspaceId !== workspaceId);
  const isDefault = widths.navigator === DEFAULT_COLUMN_WIDTHS.navigator && widths.sidebar === DEFAULT_COLUMN_WIDTHS.sidebar;
  const next = isDefault ? others : [{ workspaceId, ...widths }, ...others].slice(0, REMEMBERED_WORKSPACES);
  // A full or refused storage only means the widths are not remembered.
  try {
    if (next.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

function readStored(storage: WidthStorage | null): z.output<typeof StoredWidthsSchema> {
  const text = storage?.getItem(STORAGE_KEY);
  if (text == null) return [];
  try {
    return StoredWidthsSchema.parse(JSON.parse(text));
  } catch {
    return [];
  }
}

/** The web's `localStorage`; the phone apps have none, and a browser may refuse it. */
export function webStorage(): WidthStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
