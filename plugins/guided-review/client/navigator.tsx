import React, { useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import type { LinkedDraft } from "../shared/drafts.ts";
import { isUnderstood, type GuideProgress } from "../shared/progress.ts";
import { draftCounts, OVERVIEW_KEY, resolveSelection, type Entry, type EntryGroup } from "./guide-entries.ts";
import { plainText } from "./inline-markdown.ts";
import { ProgressContext } from "./progress.tsx";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/** Wide enough for a concept's title, narrow enough to leave the detail pane room for a diff. */
export const NAVIGATOR_WIDTH = 280;

/**
 * The entry the detail pane shows, and the way to show another. It starts where `startEntry` says,
 * and is kept once the progress is known, so marking entries understood never moves the reviewer on
 * by itself; an entry a new guide lost is swapped for where a reviewer would start in it.
 */
export function useSelection(groups: readonly EntryGroup[], progress: GuideProgress | null): [string, (key: string) => void] {
  const [selected, setSelected] = useState<string | null>(null);
  const resolved = resolveSelection(selected, groups, progress);
  if (progress !== null && resolved !== selected) setSelected(resolved);
  return [resolved, setSelected];
}

export type NavigatorProps = {
  groups: readonly EntryGroup[];
  selected: string;
  select: (key: string) => void;
  drafts: readonly LinkedDraft[];
  colors: Colors;
};

/** The guide as a tree: the overview, then each group with its entries, each with its understood tick and its number of drafts. */
export function Navigator({ groups, selected, select, drafts, colors }: NavigatorProps) {
  const progress = useContext(ProgressContext)?.progress ?? null;
  const counts = draftCounts(groups, drafts);
  /** The groups the reviewer folded or unfolded themselves; any other folds once every entry in it is understood. */
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const foldedByDefault = (group: EntryGroup) =>
    progress !== null && group.entries.every((entry) => isUnderstood(progress, entry.subject)) && !group.entries.some((entry) => entry.key === selected);

  return (
    <View accessibilityRole="list" style={{ paddingVertical: spacing[2] }}>
      <Row colors={colors} selected={selected === OVERVIEW_KEY} onPress={() => select(OVERVIEW_KEY)} depth={0}>
        <Title colors={colors} strong>
          Overview
        </Title>
        <Count colors={colors} count={counts.get(OVERVIEW_KEY)} />
      </Row>
      {groups.map((group) => {
        const folded = folds.get(group.id) ?? foldedByDefault(group);
        const understood = progress === null ? 0 : group.entries.filter((entry) => isUnderstood(progress, entry.subject)).length;
        return (
          <View key={group.id} style={{ marginTop: spacing[2] }}>
            <Row colors={colors} onPress={() => setFolds(new Map(folds).set(group.id, !folded))} depth={0} expanded={!folded}>
              <Text style={{ width: spacing[3], color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{folded ? "▸" : "▾"}</Text>
              <Title colors={colors} strong>
                {group.title}
              </Title>
              <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
                {understood}/{group.entries.length}
              </Text>
              <Tick colors={colors} place={`group:${group.title}`} subjects={group.entries.map((entry) => entry.subject)} label={`All of ${group.title} understood`} />
            </Row>
            {folded
              ? null
              : group.entries.map((entry) => (
                  <Row key={entry.key} colors={colors} selected={entry.key === selected} onPress={() => select(entry.key)} depth={1}>
                    <Tick colors={colors} place={subjectKey(entry.subject)} subjects={[entry.subject]} label="Understood" />
                    <EntryTitle entry={entry} colors={colors} />
                    <Count colors={colors} count={counts.get(entry.key)} />
                  </Row>
                ))}
          </View>
        );
      })}
    </View>
  );
}

function EntryTitle({ entry, colors }: { entry: Entry; colors: Colors }) {
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  if (entry.kind === "node") {
    return (
      <>
        <Title colors={colors}>{plainText(entry.node.title)}</Title>
        {entry.node.leaf ? <Text style={muted}>leaf</Text> : null}
      </>
    );
  }
  const slash = entry.path.lastIndexOf("/");
  const note = entry.category === null || entry.category === "test" || entry.category === "docs" ? null : entry.category;
  return (
    <>
      <Title colors={colors}>{entry.path.slice(slash + 1)}</Title>
      {note ? <Text style={muted}>{note}</Text> : null}
    </>
  );
}

function Row({
  colors,
  selected,
  depth,
  expanded,
  onPress,
  children,
}: {
  colors: Colors;
  selected?: boolean;
  depth: 0 | 1;
  expanded?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? { selected: selected ?? false } : { expanded }}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing[2],
        minHeight: 28,
        paddingVertical: spacing[1],
        paddingLeft: spacing[2] + depth * spacing[3],
        paddingRight: spacing[2],
        marginHorizontal: spacing[1],
        borderRadius: radius.base,
        backgroundColor: selected ? colors.surface2 : hovered || pressed ? colors.surface1 : undefined,
      })}
    >
      {children}
    </Pressable>
  );
}

function Title({ colors, strong, children }: { colors: Colors; strong?: boolean; children: React.ReactNode }) {
  return (
    <Text
      numberOfLines={1}
      style={{ flex: 1, color: colors.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), fontWeight: strong ? "600" : "400" }}
    >
      {children}
    </Text>
  );
}

function Count({ colors, count }: { colors: Colors; count: number | undefined }) {
  if (count === undefined) return null;
  return (
    <View
      accessibilityLabel={count === 1 ? "1 draft" : `${count} drafts`}
      style={{ minWidth: 18, paddingHorizontal: spacing[1], borderRadius: radius.full, backgroundColor: colors.surface2, alignItems: "center" }}
    >
      <Text style={{ color: colors.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{count}</Text>
    </View>
  );
}

/**
 * The navigator's own understood toggle for `subjects`, which shares its `place` with the card's or
 * heading's, so either shows the other's write as pending.
 */
function Tick({ colors, place, subjects, label }: { colors: Colors; place: string; subjects: readonly GuideSubject[]; label: string }) {
  const control = useContext(ProgressContext);
  if (control === null || control.progress === null) return null;
  const { progress } = control;
  const understood = subjects.every((subject) => isUnderstood(progress, subject));
  const pending = control.pendingKey === place;
  return (
    <Pressable
      onPress={() => control.set(place, subjects, !understood)}
      disabled={pending}
      hitSlop={spacing[1]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: understood }}
      accessibilityLabel={label}
      style={{ width: spacing[4], alignItems: "center", opacity: pending ? 0.5 : 1 }}
    >
      <Text style={{ color: understood ? colors.statusSuccess : colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.sm) }}>
        {understood ? "✓" : "○"}
      </Text>
    </Pressable>
  );
}
