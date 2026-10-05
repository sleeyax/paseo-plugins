import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { ExternalLink, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { INBOX_COLUMNS, type InboxColumn, type InboxPreferences, type InboxSortKey } from "../shared/inbox-preferences.ts";
import type { Inbox, InboxItem } from "../shared/inbox.ts";
import { numberLabel } from "../shared/reference.ts";
import { Button } from "./button.tsx";
import { age, visibleItems } from "./inbox-filter.ts";
import { useInboxPreferences } from "./inbox-preferences.ts";
import type { ReviewStart } from "./start-review.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

const FORGE_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/** The open change requests the reviewer reviews, to pick one and start or continue its review. */
export function ReviewInbox({ colors, compact, starter }: { colors: Colors; compact: boolean; starter: ReviewStart }) {
  const getInbox = useRpc(contracts.getInbox);
  const inbox = useQuery({ queryKey: [PLUGIN_ID, "inbox"], queryFn: () => getInbox({}), refetchOnWindowFocus: false });
  const { preferences, change, error } = useInboxPreferences();
  const [query, setQuery] = useState("");
  const [width, setWidth] = useState(0);
  const [choosing, setChoosing] = useState(false);

  const items = inbox.data ? visibleItems(inbox.data.items, preferences, query) : [];
  const table = !compact && width >= tableWidth(preferences.columns);

  return (
    <View onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
      <SettingsSection
        title="Assigned to me for review"
        trailing={
          <View style={{ flexDirection: "row", gap: spacing[2] }}>
            <Button colors={colors} small label="Columns" onPress={() => setChoosing(true)} />
            <Button colors={colors} small label={inbox.isFetching ? "Refreshing…" : "Refresh"} disabled={inbox.isFetching} onPress={() => void inbox.refetch()} />
          </View>
        }
      >
        <View style={{ gap: spacing[3] }}>
          <Toolbar colors={colors} preferences={preferences} change={change} query={query} setQuery={setQuery} />
          {error !== null ? <Note colors={colors} tone="danger" text={`Could not keep these filters for next time: ${error}`} /> : null}
          {inbox.data ? <HostNotes colors={colors} hosts={inbox.data.hosts} /> : null}
          {inbox.isPending ? (
            <Note colors={colors} text="Listing what you are asked to review…" />
          ) : inbox.isError ? (
            <Note colors={colors} tone="danger" text={`Could not list your reviews: ${inbox.error.message}`} />
          ) : items.length === 0 ? (
            <Note colors={colors} text={inbox.data.items.length === 0 ? "Nothing to review." : "Nothing matches these filters."} />
          ) : table ? (
            <Table colors={colors} items={items} preferences={preferences} change={change} starter={starter} />
          ) : (
            <View style={{ gap: spacing[2] }}>
              {items.map((item) => (
                <Card key={item.url} colors={colors} item={item} columns={preferences.columns} starter={starter} />
              ))}
            </View>
          )}
        </View>
      </SettingsSection>
      <ColumnChooser open={choosing} onOpenChange={setChoosing} columns={preferences.columns} change={change} />
    </View>
  );
}

const COLUMN_HINTS: Partial<Record<InboxColumn, string>> = {
  title: "Always shown",
  state: "Where you stand, and whether it changed since your review",
  local: "The guide and drafts you have for it in this plugin",
  ci: "Whether the head's pipeline or checks passed",
};

/** Which columns the table shows; the title is what a row is, so it always is. */
function ColumnChooser({
  open,
  onOpenChange,
  columns,
  change,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: readonly InboxColumn[];
  change: (update: Partial<InboxPreferences>) => void;
}) {
  const toggle = (column: InboxColumn, shown: boolean) =>
    change({ columns: INBOX_COLUMNS.filter((candidate) => (candidate === column ? shown : columns.includes(candidate))) });
  return (
    <Modal title="Columns" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <SettingsCard>
          {INBOX_COLUMNS.map((column) => (
            <SettingsSwitch
              key={column}
              label={COLUMNS[column].label}
              {...(COLUMN_HINTS[column] === undefined ? {} : { hint: COLUMN_HINTS[column] })}
              value={column === "title" || columns.includes(column)}
              disabled={column === "title"}
              onValueChange={(shown) => toggle(column, shown)}
            />
          ))}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

function Toolbar({
  colors,
  preferences,
  change,
  query,
  setQuery,
}: {
  colors: Colors;
  preferences: InboxPreferences;
  change: (update: Partial<InboxPreferences>) => void;
  query: string;
  setQuery: (query: string) => void;
}) {
  return (
    <View style={{ gap: spacing[2] }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by title, project, author or number"
        placeholderTextColor={colors.foregroundMuted}
        autoCorrect={false}
        autoCapitalize="none"
        style={{
          color: colors.foreground,
          fontSize: fontSize.base,
          lineHeight: leading(fontSize.base),
          paddingVertical: spacing[1],
          paddingHorizontal: spacing[3],
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.surface1,
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[2], alignItems: "center" }}>
        {(["all", "github", "gitlab"] as const).map((provider) => (
          <Chip
            key={provider}
            colors={colors}
            label={provider === "all" ? "All" : FORGE_NAMES[provider]}
            selected={preferences.provider === provider}
            onPress={() => change({ provider })}
          />
        ))}
        <View style={{ width: 1, alignSelf: "stretch", backgroundColor: colors.border, marginHorizontal: spacing[1] }} />
        <Chip colors={colors} label="Needs my attention" selected={preferences.needsAttention} onPress={() => change({ needsAttention: !preferences.needsAttention })} />
        <Chip colors={colors} label="Hide approved" selected={preferences.hideApproved} onPress={() => change({ hideApproved: !preferences.hideApproved })} />
        <Chip colors={colors} label="Hide drafts" selected={preferences.hideDrafts} onPress={() => change({ hideDrafts: !preferences.hideDrafts })} />
      </View>
    </View>
  );
}

function Chip({ colors, label, selected, onPress }: { colors: Colors; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        paddingVertical: 2,
        paddingHorizontal: spacing[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : undefined,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}

function Note({ colors, text, tone }: { colors: Colors; text: string; tone?: "danger" }) {
  return (
    <Text style={{ color: tone === "danger" ? colors.statusDanger : colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {text}
    </Text>
  );
}

/** A host that could not be listed, or has more than one page, says so; the rest list as usual. */
function HostNotes({ colors, hosts }: { colors: Colors; hosts: Inbox["hosts"] }) {
  const notes = hosts.flatMap((host): { key: string; tone?: "danger"; text: string }[] => {
    if (host.error !== null) return [{ key: host.host, tone: "danger", text: `${host.host}: ${host.error}` }];
    if (host.truncated) return [{ key: host.host, text: `${host.host} has more than this lists; only the first page is shown.` }];
    return [];
  });
  if (notes.length === 0) return null;
  return (
    <View style={{ gap: spacing[1] }}>
      {notes.map((note) => (
        <Note key={note.key} colors={colors} tone={note.tone} text={note.text} />
      ))}
    </View>
  );
}

type Tinted = { text: string; color: keyof Colors };

/** Where the reviewer stands, with whether it moved on since their review. */
function stateOf(item: InboxItem): Tinted {
  const since = item.changedSinceReview === true;
  switch (item.state) {
    case "requested":
      if (item.viaTeam !== null) return { text: `Requested via ${item.viaTeam}`, color: "foreground" };
      return { text: since ? "Requested again" : "Requested", color: "foreground" };
    case "commented":
      return { text: since ? "Commented · updated since" : "Commented", color: since ? "statusWarning" : "foregroundMuted" };
    case "changes-requested":
      return { text: since ? "Changes requested · updated since" : "Changes requested", color: since ? "statusWarning" : "foregroundMuted" };
    case "approved":
      return { text: since ? "Approved · updated since" : "Approved", color: since ? "statusWarning" : "statusSuccess" };
    case "unapproved":
      return { text: "Approval reset", color: "statusWarning" };
  }
}

/** What this plugin has of the review, and the reviewer's pending drafts wherever they were written. */
function localOf(item: InboxItem): Tinted | null {
  const drafts = item.pendingDrafts ? [`${item.pendingDrafts} draft${item.pendingDrafts === 1 ? "" : "s"}`] : [];
  if (item.local === null) return drafts.length > 0 ? { text: drafts.join(" · "), color: "foregroundMuted" } : null;
  const guide = { none: "Started", generating: "Guide generating", ready: "Guide ready", failed: "Guide failed" }[item.local.guide];
  const parts = [guide, ...(item.local.headMoved ? ["head moved"] : []), ...drafts];
  const color = item.local.guide === "failed" ? "statusDanger" : item.local.headMoved ? "statusWarning" : "foregroundMuted";
  return { text: parts.join(" · "), color };
}

function ciOf(item: InboxItem): Tinted | null {
  switch (item.ci) {
    case "success":
      return { text: "Passed", color: "statusSuccess" };
    case "failure":
      return { text: "Failed", color: "statusDanger" };
    case "pending":
      return { text: "Running", color: "statusWarning" };
    case null:
      return null;
  }
}

function linesOf(item: InboxItem): string {
  return `+${item.additions} −${item.deletions}`;
}

function filesOf(item: InboxItem): string {
  return `${item.fileCount} file${item.fileCount === 1 ? "" : "s"}`;
}

/** A column's width: fixed for a value whose length is known, else a share of what is left, never under `min`. */
type ColumnWidth = { width: number } | { flex: number; min: number };

type ColumnSpec = { label: string; size: ColumnWidth; sort?: InboxSortKey; cell: (item: InboxItem, colors: Colors, now: Date) => React.ReactNode };

const COLUMNS: Record<InboxColumn, ColumnSpec> = {
  change: {
    label: "PR/MR",
    size: { flex: 1.2, min: 96 },
    cell: (item, colors) => (
      <View>
        <NumberLink colors={colors} item={item} />
        <Cell colors={colors} text={item.project} color="foregroundMuted" />
      </View>
    ),
  },
  title: { label: "Title", size: { flex: 3, min: 160 }, cell: (item, colors) => <Title colors={colors} item={item} /> },
  author: { label: "Author", size: { flex: 1, min: 64 }, cell: (item, colors) => <Cell colors={colors} text={item.author} color="foregroundMuted" /> },
  updated: { label: "Updated", size: { width: 72 }, sort: "updated", cell: (item, colors, now) => <Cell colors={colors} text={age(item.updatedAt, now)} color="foregroundMuted" /> },
  created: { label: "Created", size: { width: 72 }, sort: "created", cell: (item, colors, now) => <Cell colors={colors} text={age(item.createdAt, now)} color="foregroundMuted" /> },
  size: {
    label: "Size",
    size: { width: 80 },
    sort: "size",
    cell: (item, colors) => (
      <View>
        <Cell colors={colors} text={linesOf(item)} color="foregroundMuted" />
        <Cell colors={colors} text={filesOf(item)} color="foregroundMuted" />
      </View>
    ),
  },
  ci: { label: "CI", size: { width: 64 }, cell: (item, colors) => <TintedCell colors={colors} value={ciOf(item)} /> },
  state: { label: "My review", size: { flex: 1.4, min: 96 }, cell: (item, colors) => <TintedCell colors={colors} value={stateOf(item)} /> },
  local: { label: "Here", size: { flex: 1.4, min: 96 }, cell: (item, colors) => <TintedCell colors={colors} value={localOf(item)} /> },
};

const ACTIONS_WIDTH = 88;
const CELL_GAP = spacing[3];

function columnStyle(size: ColumnWidth) {
  return "width" in size ? { width: size.width } : { flex: size.flex, minWidth: size.min };
}

/** The narrowest the table can be with these columns before its cells crowd; anything narrower gets cards. */
function tableWidth(columns: readonly InboxColumn[]): number {
  const cells = columns.reduce((total, column) => {
    const { size } = COLUMNS[column];
    return total + ("width" in size ? size.width : size.min);
  }, 0);
  return cells + ACTIONS_WIDTH + CELL_GAP * columns.length + spacing[3] * 2 + 2;
}

function Cell({ colors, text, color, lines = 1 }: { colors: Colors; text: string; color?: keyof Colors; lines?: number }) {
  return (
    <Text numberOfLines={lines} style={{ color: colors[color ?? "foreground"], fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {text}
    </Text>
  );
}

/** Two lines, since a state or what is kept here can run to a few words. */
function TintedCell({ colors, value }: { colors: Colors; value: Tinted | null }) {
  return value === null ? <Cell colors={colors} text="—" color="foregroundMuted" /> : <Cell colors={colors} text={value.text} color={value.color} lines={2} />;
}

/** The change request's number as its forge writes it, linking to it there. */
function NumberLink({ colors, item }: { colors: Colors; item: InboxItem }) {
  return (
    <ExternalLink href={item.url} accessibilityLabel={`Open ${numberLabel(item.forge, item.number)} on ${FORGE_NAMES[item.forge]}`}>
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{numberLabel(item.forge, item.number)}</Text>
    </ExternalLink>
  );
}

function Title({ colors, item }: { colors: Colors; item: InboxItem }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[1] }}>
      {item.isDraft ? <Badge colors={colors} text="Draft" /> : null}
      <Text numberOfLines={2} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
        {item.title}
      </Text>
    </View>
  );
}

function Badge({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing[1] }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{text}</Text>
    </View>
  );
}

/** The one way into the review from a row: a row itself starts nothing, so a click elsewhere on it is safe. */
function StartButton({ colors, item, starter }: { colors: Colors; item: InboxItem; starter: ReviewStart }) {
  const starting = starter.busy && starter.from === item.url;
  return (
    <Button
      colors={colors}
      small
      primary={item.local === null}
      label={starting ? "Starting…" : item.local === null ? "Review" : "Continue"}
      disabled={starter.busy}
      onPress={() => void starter.start(item.url, item.url)}
    />
  );
}

/** How the start from this row is going, under it, once one began from it. */
function RowStatus({ colors, item, starter }: { colors: Colors; item: InboxItem; starter: ReviewStart }) {
  if (starter.from !== item.url) return null;
  if (starter.rejection !== null) return <Note colors={colors} tone="danger" text={starter.rejection} />;
  if (starter.status === null) return null;
  return <Note colors={colors} tone={starter.status.tone === "danger" ? "danger" : undefined} text={starter.status.text} />;
}

function Table({
  colors,
  items,
  preferences,
  change,
  starter,
}: {
  colors: Colors;
  items: InboxItem[];
  preferences: InboxPreferences;
  change: (update: Partial<InboxPreferences>) => void;
  starter: ReviewStart;
}) {
  const now = new Date();
  const columns = preferences.columns.map((id) => ({ id, ...COLUMNS[id] }));
  const sortBy = (key: InboxSortKey) =>
    change({ sort: { key, descending: preferences.sort.key === key ? !preferences.sort.descending : true } });

  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", gap: CELL_GAP, paddingVertical: spacing[2], paddingHorizontal: spacing[3], backgroundColor: colors.surface1 }}>
        {columns.map((column) => {
          const sorted = column.sort !== undefined && preferences.sort.key === column.sort;
          const label = sorted ? `${column.label} ${preferences.sort.descending ? "↓" : "↑"}` : column.label;
          const text = (
            <Text
              numberOfLines={1}
              style={{ color: sorted ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), fontWeight: "600" }}
            >
              {label}
            </Text>
          );
          return (
            <View key={column.id} style={columnStyle(column.size)}>
              {column.sort === undefined ? (
                text
              ) : (
                <Pressable accessibilityRole="button" onPress={() => sortBy(column.sort!)}>
                  {text}
                </Pressable>
              )}
            </View>
          );
        })}
        <View style={{ width: ACTIONS_WIDTH }} />
      </View>
      {items.map((item) => (
        <View
          key={item.url}
          style={{ paddingVertical: spacing[2], paddingHorizontal: spacing[3], borderTopWidth: 1, borderTopColor: colors.border, gap: spacing[1] }}
        >
          <View style={{ flexDirection: "row", gap: CELL_GAP, alignItems: "center" }}>
            {columns.map((column) => (
              <View key={column.id} style={columnStyle(column.size)}>
                {column.cell(item, colors, now)}
              </View>
            ))}
            <View style={{ width: ACTIONS_WIDTH, alignItems: "flex-end" }}>
              <StartButton colors={colors} item={item} starter={starter} />
            </View>
          </View>
          <RowStatus colors={colors} item={item} starter={starter} />
        </View>
      ))}
    </View>
  );
}

/** A row stacked for a narrow screen: the title, then whichever of the other columns are shown, as lines. */
function Card({ colors, item, columns, starter }: { colors: Colors; item: InboxItem; columns: readonly InboxColumn[]; starter: ReviewStart }) {
  const now = new Date();
  const shown = (column: InboxColumn) => columns.includes(column);
  const meta = [
    ...(shown("change") ? [item.project] : []),
    ...(shown("author") ? [item.author] : []),
    ...(shown("updated") ? [`updated ${age(item.updatedAt, now)} ago`] : []),
    ...(shown("created") ? [`opened ${age(item.createdAt, now)} ago`] : []),
    ...(shown("size") ? [`${linesOf(item)} in ${filesOf(item)}`] : []),
  ];
  const tinted = [shown("state") ? stateOf(item) : null, shown("local") ? localOf(item) : null, shown("ci") ? ciOf(item) : null].filter(
    (value) => value !== null,
  );

  return (
    <View style={{ padding: spacing[3], gap: spacing[1], borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
      <Title colors={colors} item={item} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing[1] }}>
        <NumberLink colors={colors} item={item} />
        {meta.length > 0 ? (
          <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>· {meta.join(" · ")}</Text>
        ) : null}
      </View>
      {tinted.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: spacing[3] }}>
          {tinted.map((value) => (
            <Cell key={value.text} colors={colors} text={value.text} color={value.color} />
          ))}
        </View>
      ) : null}
      <View style={{ marginTop: spacing[1], alignItems: "flex-start" }}>
        <StartButton colors={colors} item={item} starter={starter} />
      </View>
      <RowStatus colors={colors} item={item} starter={starter} />
    </View>
  );
}
