import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Platform, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { DiffHunk, DiffLine, FileDiff } from "../shared/diff.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
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
const MARKERS = { added: "+", removed: "−", context: " " } as const;

export type NodeCodeProps = {
  reviewId: string;
  /** The guide's agent: a regenerated guide is a new agent, whose nodes may cover other code under the same IDs. */
  agentId: string;
  nodeId: string;
  theme: PluginTheme;
};

/** The code a node covers, read from the server once per guide. */
export function NodeCode({ reviewId, agentId, nodeId, theme }: NodeCodeProps) {
  const getNodeDiff = useRpc(contracts.getNodeDiff);
  const diff = useQuery({
    queryKey: [PLUGIN_ID, "node-diff", reviewId, agentId, nodeId],
    queryFn: () => getNodeDiff({ reviewId, nodeId }),
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

/** One file's hunks in a monospace block: a header naming the file, then each hunk under its `@@` line. */
export function FileDiffView({ file, colors }: { file: FileDiff; colors: Colors }) {
  const width = numberWidth(file);
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surface0 }}>
      <FileHeader file={file} colors={colors} />
      {file.withheld ? (
        <Muted colors={colors} padded>
          {withheldReason(file)}
        </Muted>
      ) : (
        file.hunks.map((hunk) => (
          <View key={`${hunk.index}:${hunk.lines[0]?.oldPos}:${hunk.lines[0]?.newPos}`}>
            <HunkHeader hunk={hunk} colors={colors} />
            {hunk.lines.map((line, index) => (
              <DiffLineRow key={index} line={line} width={width} colors={colors} />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

function FileHeader({ file, colors }: { file: FileDiff; colors: Colors }) {
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

/** One line: its old and new numbers, its marker, and its text, tinted when added or removed. */
export function DiffLineRow({ line, width, colors }: { line: DiffLine; width: number; colors: Colors }) {
  const accent = line.kind === "added" ? colors.statusSuccess : line.kind === "removed" ? colors.statusDanger : null;
  const code = { fontFamily: MONO_FONT, fontSize: CODE_SIZE, lineHeight: CODE_LEADING };
  const number = { ...code, width, textAlign: "right" as const, color: colors.foregroundMuted, paddingRight: spacing[1] };
  return (
    <>
      <View style={{ flexDirection: "row", backgroundColor: accent ? tint(accent, colors.surface0, LINE_TINT) : undefined }}>
        <Text style={number}>{line.oldLine ?? ""}</Text>
        <Text style={number}>{line.newLine ?? ""}</Text>
        <Text style={{ ...code, width: DIGIT_WIDTH * 2, textAlign: "center", color: accent ?? colors.foregroundMuted }}>{MARKERS[line.kind]}</Text>
        <Text style={{ ...code, flex: 1, color: colors.foreground, paddingRight: spacing[2] }}>{expandTabs(line.text)}</Text>
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
