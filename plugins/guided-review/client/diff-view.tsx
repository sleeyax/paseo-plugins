import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useContext, useId, useRef, useState } from "react";
import { Platform, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import type { DiffHunk, DiffLine, FileDiff } from "../shared/diff.ts";
import { isLine, lastLineOf, lineRefOf, type DraftLocation, type LineRef } from "../shared/drafts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { DraftCard, DraftsContext, NewCommentBox, type DraftsControl } from "./drafts.tsx";
import { fontSize, leading, radius, spacing, tint } from "./theme.ts";

type Colors = PluginTheme["colors"];

/** The host has no monospace token; this is the stack Paseo's own code views use. */
export const MONO_FONT =
  Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  }) ?? "monospace";

const CODE_SIZE = fontSize.sm;
const CODE_LEADING = leading(CODE_SIZE);
/** A monospace digit is about this wide at `CODE_SIZE`; the number columns are sized in digits. */
const DIGIT_WIDTH = CODE_SIZE * 0.62;
/** Added and removed lines are tinted this much of their status colour over the card. */
const LINE_TINT = 0.14;
/** Lines selected to comment on are tinted this much of the accent. */
const SELECTED_TINT = 0.28;
const MARKERS = { added: "+", removed: "−", context: " " } as const;

export type NodeCodeProps = {
  reviewId: string;
  /** The guide's agent: a regenerated guide is a new agent, whose nodes may cover other code under the same IDs. */
  agentId: string;
  /** A node, for the hunks it covers, or a Supporting or Unsorted file, for its whole diff. */
  subject: GuideSubject;
  theme: PluginTheme;
};

/** The code a node or a file entry covers, read from the server once per guide. */
export function NodeCode({ reviewId, agentId, subject, theme }: NodeCodeProps) {
  const getNodeDiff = useRpc(contracts.getNodeDiff);
  const diff = useQuery({
    queryKey: [PLUGIN_ID, "node-diff", reviewId, agentId, subjectKey(subject)],
    queryFn: () => getNodeDiff({ reviewId, subject }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const colors = theme.colors;

  if (diff.isPending) return <Muted colors={colors}>Reading the code…</Muted>;
  if (diff.isError) {
    return <Muted colors={colors} color={colors.statusDanger}>{diff.error instanceof Error ? diff.error.message : String(diff.error)}</Muted>;
  }
  return (
    <View style={{ gap: spacing[3], marginTop: spacing[1] }}>
      {diff.data.files.map((file) => (
        <FileDiffView key={file.path} file={file} colors={colors} />
      ))}
    </View>
  );
}

/**
 * One file's hunks in a monospace block: a header naming the file, then each hunk under its `@@`
 * line. Inside a review (`DraftsContext`) the reviewer comments from here: on a line by tapping it,
 * on a range by dragging across lines, on the file from its header; their drafts show under the
 * lines they are on.
 */
export function FileDiffView({ file, colors }: { file: FileDiff; colors: Colors }) {
  const width = numberWidth(file);
  const drafts = useContext(DraftsContext);
  const place = useId();
  const fileBox = drafts?.open?.kind === "new" && drafts.open.place === `${place}:file` ? drafts.open : null;
  const fileDrafts = drafts?.drafts.filter((draft) => draft.location.path === file.path && draft.location.kind === "file") ?? [];
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surface0 }}>
      <FileHeader
        file={file}
        colors={colors}
        {...(drafts
          ? { onComment: () => drafts.setOpen({ kind: "new", place: `${place}:file`, location: { kind: "file", path: file.path } }) }
          : {})}
      />
      {drafts && (fileBox || fileDrafts.length > 0) ? (
        <View style={{ gap: spacing[2], padding: spacing[2] }}>
          {fileDrafts.map((draft) => (
            <DraftCard key={draft.id} control={drafts} draft={draft} place={place} colors={colors} />
          ))}
          {fileBox ? <NewCommentBox control={drafts} location={fileBox.location} colors={colors} /> : null}
        </View>
      ) : null}
      {file.withheld ? (
        <Muted colors={colors} padded>
          {withheldReason(file)}
        </Muted>
      ) : (
        file.hunks.map((hunk) => {
          const key = `${hunk.index}:${hunk.lines[0]?.oldPos}:${hunk.lines[0]?.newPos}`;
          return (
            <View key={key}>
              <HunkHeader hunk={hunk} colors={colors} />
              <HunkLines path={file.path} hunk={hunk} width={width} colors={colors} drafts={drafts} place={`${place}:${key}`} draftPlace={place} />
            </View>
          );
        })
      )}
    </View>
  );
}

/** How long a finger rests on a line before dragging selects lines rather than scrolling, on a touch screen. */
const HOLD_TO_SELECT_MS = 350;
/** A pointer that moves less than this between press and release tapped. */
const TAP_SLOP = 6;

type Selection = { from: number; to: number };

/**
 * A hunk's lines, which the reviewer selects to comment on: a tap selects a line and a drag the
 * lines it crosses, within this hunk because a forge's range cannot leave one. With a mouse a drag
 * selects at once; on a touch screen the finger rests first, so a plain swipe still scrolls.
 */
function HunkLines({
  path,
  hunk,
  width,
  colors,
  drafts,
  place,
  draftPlace,
}: {
  path: string;
  hunk: DiffHunk;
  width: number;
  colors: Colors;
  drafts: DraftsControl | null;
  /** Where this hunk is in the panel, for the comment box it opens. */
  place: string;
  /** Where the file is, for its drafts' edit boxes. */
  draftPlace: string;
}) {
  const [dragging, setDragging] = useState<Selection | null>(null);
  const selection = useRef<Selection | null>(null);
  const container = useRef<View>(null);
  /** Each line's box, relative to the container, from its layout. */
  const rows = useRef<{ y: number; height: number }[]>([]);
  /** The container's top on the page, measured when a press starts. */
  const origin = useRef<number | null>(null);
  /** The line the press started on, which its row reports as the press bubbles past it. */
  const pressed = useRef<number | null>(null);
  const press = useRef({ pageY: 0, moved: false, armed: false, timer: null as ReturnType<typeof setTimeout> | null });

  const box = drafts?.open?.kind === "new" && drafts.open.place === place ? drafts.open : null;
  const shown = dragging ?? (box ? selectionOf(hunk, box.location) : null);
  const [low, high] = shown ? [Math.min(shown.from, shown.to), Math.max(shown.from, shown.to)] : [-1, -1];

  const select = (next: Selection | null) => {
    selection.current = next;
    setDragging(next);
  };
  const lineAt = (pageY: number): number | null => {
    if (origin.current === null) return null;
    const y = pageY - origin.current;
    for (let index = 0; index < hunk.lines.length; index++) {
      const row = rows.current[index];
      if (row && y < row.y + row.height) return index;
    }
    return hunk.lines.length - 1;
  };
  const endPress = () => {
    if (press.current.timer !== null) clearTimeout(press.current.timer);
    press.current.timer = null;
  };

  const responder =
    drafts === null
      ? {}
      : {
          onStartShouldSetResponder: () => pressed.current !== null,
          onResponderGrant: (event: GestureResponderEvent) => {
            const from = pressed.current!;
            pressed.current = null;
            press.current = { pageY: event.nativeEvent.pageY, moved: false, armed: Platform.OS === "web", timer: null };
            if (!press.current.armed) {
              press.current.timer = setTimeout(() => {
                press.current.armed = true;
              }, HOLD_TO_SELECT_MS);
            }
            origin.current = null;
            container.current?.measure((_x, _y, _width, _height, _pageX, pageY) => {
              origin.current = pageY;
            });
            select({ from, to: from });
          },
          onResponderMove: (event: GestureResponderEvent) => {
            if (Math.abs(event.nativeEvent.pageY - press.current.pageY) > TAP_SLOP) press.current.moved = true;
            if (!press.current.armed || selection.current === null) return;
            const to = lineAt(event.nativeEvent.pageY);
            if (to !== null && to !== selection.current.to) select({ ...selection.current, to });
          },
          // Until the finger has rested, a swipe is the scroll view's to take.
          onResponderTerminationRequest: () => !press.current.armed,
          onResponderRelease: () => {
            endPress();
            const chosen = selection.current;
            select(null);
            if (chosen === null || (press.current.moved && !press.current.armed)) return;
            drafts.setOpen({ kind: "new", place, location: locationOf(path, hunk, chosen) });
          },
          onResponderTerminate: () => {
            endPress();
            select(null);
          },
        };

  return (
    <View ref={container} {...responder}>
      {hunk.lines.map((line, index) => {
        const lineDrafts =
          drafts?.drafts.filter((draft) => {
            const last = draft.location.path === path ? lastLineOf(draft.location) : null;
            return last !== null && isLine(line, last);
          }) ?? [];
        return (
          <React.Fragment key={index}>
            <View
              onLayout={(event) => {
                rows.current[index] = { y: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height };
              }}
              onStartShouldSetResponder={() => {
                pressed.current = index;
                return false;
              }}
            >
              <DiffLineRow line={line} width={width} colors={colors} selected={index >= low && index <= high} {...(drafts === null ? {} : { selectable: false })} />
            </View>
            {drafts && lineDrafts.length > 0 ? (
              <View style={{ gap: spacing[2], padding: spacing[2] }}>
                {lineDrafts.map((draft) => (
                  <DraftCard key={draft.id} control={drafts} draft={draft} place={draftPlace} colors={colors} />
                ))}
              </View>
            ) : null}
            {drafts && box && index === high ? (
              <View style={{ padding: spacing[2] }}>
                <NewCommentBox control={drafts} location={box.location} colors={colors} />
              </View>
            ) : null}
          </React.Fragment>
        );
      })}
    </View>
  );
}

/** The draft location of lines `from` to `to` of a hunk: a line, or a range in the diff's order. */
function locationOf(path: string, hunk: DiffHunk, { from, to }: Selection): DraftLocation {
  const first = hunk.lines[Math.min(from, to)]!;
  const last = hunk.lines[Math.max(from, to)]!;
  if (first === last) return { kind: "line", path, line: lineRefOf(first) };
  return { kind: "range", path, start: lineRefOf(first), end: lineRefOf(last) };
}

/** Which of a hunk's lines a location covers, for the box this hunk opened. */
function selectionOf(hunk: DiffHunk, location: DraftLocation): Selection | null {
  const index = (ref: LineRef) => hunk.lines.findIndex((line) => isLine(line, ref));
  switch (location.kind) {
    case "line": {
      const at = index(location.line);
      return at === -1 ? null : { from: at, to: at };
    }
    case "range": {
      const from = index(location.start);
      const to = index(location.end);
      return from === -1 || to === -1 ? null : { from, to };
    }
    case "file":
      return null;
  }
}

function FileHeader({ file, colors, onComment }: { file: FileDiff; colors: Colors; onComment?: () => void }) {
  const status = STATUS_LABELS[file.status];
  const small = { fontSize: CODE_SIZE, lineHeight: CODE_LEADING };
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: spacing[2],
        paddingVertical: spacing[1],
        paddingHorizontal: spacing[2],
        backgroundColor: colors.surface2,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ ...small, fontFamily: MONO_FONT, color: colors.foreground, fontWeight: "600", flexShrink: 1 }}>{file.path}</Text>
      {file.previousPath ? <Text style={{ ...small, color: colors.foregroundMuted }}>from {file.previousPath}</Text> : null}
      {status ? <Text style={{ ...small, color: colors.foregroundMuted }}>{status}</Text> : null}
      <Text style={small}>
        <Text style={{ color: colors.statusSuccess }}>+{file.additions}</Text> <Text style={{ color: colors.statusDanger }}>−{file.deletions}</Text>
      </Text>
      {!file.withheld && file.hunks.length > 0 && !covers(file) ? (
        <Text style={{ ...small, color: colors.foregroundMuted }}>part of the file's changes</Text>
      ) : null}
      {onComment ? (
        <Pressable onPress={onComment} accessibilityRole="button" hitSlop={4} style={{ marginLeft: "auto" }}>
          <Text style={{ ...small, color: colors.accent }}>Comment on file</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function HunkHeader({ hunk, colors }: { hunk: DiffHunk; colors: Colors }) {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ""}`;
  return (
    <Text
      style={{
        fontFamily: MONO_FONT,
        fontSize: CODE_SIZE,
        lineHeight: CODE_LEADING,
        color: colors.foregroundMuted,
        backgroundColor: tint(colors.accent, colors.surface0, 0.08),
        paddingHorizontal: spacing[2],
        paddingVertical: 2,
      }}
    >
      {header}
    </Text>
  );
}

/**
 * One line: its old and new numbers, its marker, and its text, tinted when added or removed, or when
 * `selected` to comment on. `selectable={false}` keeps a drag across lines from selecting their text on the web.
 */
export function DiffLineRow({
  line,
  width,
  colors,
  selected,
  selectable,
}: {
  line: DiffLine;
  width: number;
  colors: Colors;
  selected?: boolean;
  selectable?: boolean;
}) {
  const accent = line.kind === "added" ? colors.statusSuccess : line.kind === "removed" ? colors.statusDanger : null;
  const code = { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: CODE_LEADING };
  const number = { ...code, width, textAlign: "right" as const, color: colors.foregroundMuted, paddingRight: spacing[1] };
  const background = selected ? tint(colors.accent, colors.surface0, SELECTED_TINT) : accent ? tint(accent, colors.surface0, LINE_TINT) : undefined;
  return (
    <>
      <View style={{ flexDirection: "row", backgroundColor: background }}>
        <Text selectable={selectable} style={number}>{line.oldLine ?? ""}</Text>
        <Text selectable={selectable} style={number}>{line.newLine ?? ""}</Text>
        <Text selectable={selectable} style={{ ...code, width: DIGIT_WIDTH * 2, textAlign: "center", color: accent ?? colors.foregroundMuted }}>{MARKERS[line.kind]}</Text>
        <Text selectable={selectable} style={{ ...code, flex: 1, color: colors.foreground, paddingRight: spacing[2] }}>{expandTabs(line.text)}</Text>
      </View>
      {line.noNewlineAtEnd ? (
        <Text style={{ ...code, color: colors.foregroundMuted, paddingLeft: width * 2 + DIGIT_WIDTH * 2 }}>No newline at end of file</Text>
      ) : null}
    </>
  );
}

function Muted({ colors, color, padded, children }: { colors: Colors; color?: string; padded?: boolean; children: React.ReactNode }) {
  return (
    <Text
      style={{
        color: color ?? colors.foregroundMuted,
        fontSize: fontSize.sm,
        lineHeight: leading(fontSize.sm),
        ...(padded ? { padding: spacing[2] } : {}),
      }}
    >
      {children}
    </Text>
  );
}

const STATUS_LABELS: Partial<Record<FileDiff["status"], string>> = {
  added: "new file",
  removed: "deleted",
  renamed: "renamed",
  copied: "copied",
};

function withheldReason(file: FileDiff): string {
  if ((file.status === "renamed" || file.status === "copied") && file.additions === 0 && file.deletions === 0) {
    return "No diff to show: the file was moved without changes to its text, or is binary.";
  }
  return "No diff to show: the file is binary, or too large for the forge to show. Read it in the repository.";
}

/** Whether the node covers every hunk of the file whole. */
function covers(file: FileDiff): boolean {
  return file.hunks.length === file.hunkCount && file.hunks.every((hunk) => hunk.complete);
}

/** Wide enough for the file's largest line number, in both number columns. */
function numberWidth(file: FileDiff): number {
  let largest = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) largest = Math.max(largest, line.oldLine ?? 0, line.newLine ?? 0);
  }
  return Math.ceil(Math.max(2, String(largest).length) * DIGIT_WIDTH) + spacing[2];
}

function expandTabs(text: string): string {
  return text.replaceAll("\t", "    ");
}
