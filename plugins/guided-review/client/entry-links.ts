import { createContext } from "react";
import type { EntryGroup } from "./guide-entries.ts";

/** What a link to an entry needs: the navigator's groups, to find the entry, and the way to select it. */
export type EntryLinks = { groups: readonly EntryGroup[]; select: (key: string) => void };

/** Null in the stack, which has no navigator, so nothing there turns into a link. */
export const EntryLinksContext = createContext<EntryLinks | null>(null);
