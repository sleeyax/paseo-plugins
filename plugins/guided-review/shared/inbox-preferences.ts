import { z } from "zod";

/** Every column the review list can show, in the order it shows them; the title is what a row is, so it is always shown. */
export const INBOX_COLUMNS = ["platform", "change", "title", "author", "updated", "created", "size", "ci", "state", "local"] as const;
export type InboxColumn = (typeof INBOX_COLUMNS)[number];

export const DEFAULT_INBOX_COLUMNS: readonly InboxColumn[] = ["platform", "change", "title", "author", "updated", "state", "local"];

export const INBOX_SORT_KEYS = ["updated", "created", "size"] as const;
export type InboxSortKey = (typeof INBOX_SORT_KEYS)[number];

/**
 * How the reviewer last left the review list. Each field falls back to its default on its own, so
 * a file written by an older or newer plugin keeps whatever of it still means something.
 */
export const InboxPreferencesSchema = z.object({
  provider: z.enum(["all", "github", "gitlab"]).catch("all"),
  hideApproved: z.boolean().catch(true),
  hideDrafts: z.boolean().catch(false),
  needsAttention: z.boolean().catch(false),
  sort: z.object({ key: z.enum(INBOX_SORT_KEYS), descending: z.boolean() }).catch({ key: "updated", descending: true }),
  columns: z
    .array(z.string())
    .transform((columns) => INBOX_COLUMNS.filter((column) => column === "title" || columns.includes(column)))
    .catch([...DEFAULT_INBOX_COLUMNS]),
});

export type InboxPreferences = z.output<typeof InboxPreferencesSchema>;

export const DEFAULT_INBOX_PREFERENCES: InboxPreferences = InboxPreferencesSchema.parse({});
