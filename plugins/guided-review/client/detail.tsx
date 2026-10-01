import type { PluginTheme } from "@getpaseo/plugin";
import React, { useContext, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { subjectKey } from "../shared/contracts.ts";
import type { LayeredGuide } from "../shared/guide.ts";
import { isUnderstood } from "../shared/progress.ts";
import type { AskControl } from "./ask-action.tsx";
import { Button } from "./button.tsx";
import { NodeCode } from "./diff-view.tsx";
import { FINISH_KEY, nextNotUnderstood, OVERVIEW_KEY, stepEntry, type Entry, type EntryGroup } from "./guide-entries.ts";
import { Card, FileEntry, Link, NodeCard, Overview, UnsortedNote } from "./guide-view.tsx";
import { ProgressContext } from "./progress.tsx";
import { fontSize, leading, spacing, type Colors } from "./theme.ts";

export type DetailProps = {
  reviewId: string;
  agentId: string;
  guide: LayeredGuide;
  groups: readonly EntryGroup[];
  selected: string;
  select: (key: string) => void;
  theme: PluginTheme;
  ask: AskControl;
  openAgent?: (agentId: string) => void;
  /** The Finish review page, shown for `FINISH_KEY`. */
  finish: React.ReactNode;
};

/**
 * The selected entry, read on its own, with the way on to the next at the foot of the pane.
 * An entry is drawn the first time it is selected and kept, hidden, after, so a comment half written
 * in it and where it was scrolled to are still there when the reviewer comes back.
 */
export function Detail({ reviewId, agentId, guide, groups, selected, select, theme, ask, openAgent, finish }: DetailProps) {
  const colors = theme.colors;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  const visited = useRef(new Set<string>());
  visited.current.add(selected);
  const entries = new Map(groups.flatMap((group) => group.entries.map((entry) => [entry.key, { entry, group }] as const)));

  const page = (key: string): React.ReactNode => {
    if (key === FINISH_KEY) return finish;
    if (key === OVERVIEW_KEY) {
      return (
        <>
          <Overview guide={guide} colors={colors} />
          {openAgent ? (
            <View style={{ alignItems: "flex-start" }}>
              <Link colors={colors} label="Open the guide agent" onPress={() => openAgent(agentId)} />
            </View>
          ) : null}
        </>
      );
    }
    const found = entries.get(key);
    if (found === undefined) return null;
    const { entry, group } = found;
    const code = <NodeCode reviewId={reviewId} agentId={agentId} subject={entry.subject} theme={theme} />;
    return (
      <>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{group.title}</Text>
        {entry.kind === "node" ? (
          <NodeCard node={entry.node} titles={titles} colors={colors} ask={ask} code={code} collapsible={false} />
        ) : (
          <Card colors={colors}>
            {group.kind === "unsorted" ? <UnsortedNote colors={colors} /> : null}
            <FileEntry colors={colors} entry={entry} ask={ask} code={code} collapsible={false} />
          </Card>
        )}
      </>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {[...visited.current].map((key) => {
        const content = page(key);
        if (content === null) return null;
        return (
          <ScrollView
            key={key}
            style={{ flex: 1, display: key === selected ? "flex" : "none" }}
            contentContainerStyle={{ gap: spacing[3], padding: spacing[4] }}
          >
            {content}
          </ScrollView>
        );
      })}
      {selected === FINISH_KEY ? null : <Steps groups={groups} selected={selected} select={select} entry={entries.get(selected)?.entry ?? null} colors={colors} />}
    </View>
  );
}

/** Previous and Next in the navigator's order, and the one that marks the entry understood and moves on to the next that is not. */
function Steps({
  groups,
  selected,
  select,
  entry,
  colors,
}: {
  groups: readonly EntryGroup[];
  selected: string;
  select: (key: string) => void;
  entry: Entry | null;
  colors: Colors;
}) {
  const control = useContext(ProgressContext);
  const progress = control?.progress ?? null;
  const previous = stepEntry(groups, selected, -1);
  const next = stepEntry(groups, selected, 1);
  const unread = nextNotUnderstood(groups, selected, progress);
  const understood = entry !== null && progress !== null && isUnderstood(progress, entry.subject);

  let main: React.ReactNode = null;
  if (control !== null && progress !== null && entry !== null && !understood) {
    const place = subjectKey(entry.subject);
    main = (
      <Button
        small
        primary
        colors={colors}
        label={unread === null ? "Understood" : "Understood → next"}
        disabled={control.pendingKey === place}
        onPress={() => {
          control.set(place, [entry.subject], true);
          if (unread !== null) select(unread);
        }}
      />
    );
  } else if (unread !== null) {
    main = <Button small primary colors={colors} label="Next not understood" onPress={() => select(unread)} />;
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing[2],
        paddingVertical: spacing[2],
        paddingHorizontal: spacing[4],
        borderTopWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Button small colors={colors} label="← Previous" disabled={previous === null} onPress={() => previous !== null && select(previous)} />
      <Button small colors={colors} label="Next →" disabled={next === null} onPress={() => next !== null && select(next)} />
      <View style={{ flex: 1 }} />
      {main}
    </View>
  );
}
