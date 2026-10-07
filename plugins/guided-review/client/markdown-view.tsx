import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { MONO_FONT } from "./diff-view.tsx";
import { linkTarget, type Align, type Block, type ImageBlock, type ListItem, type Span } from "./markdown.ts";
import { openLink } from "./open-link.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/** What every block needs: links and images resolve against `projectUrl`, and images are fetched for `reviewId`. */
type Context = { reviewId: string; projectUrl: string; colors: Colors; color: string };

/** The blocks `parseMarkdown` reads a description into, drawn in the guide's type scale. */
export function MarkdownView({ blocks, reviewId, projectUrl, colors }: { blocks: readonly Block[]; reviewId: string; projectUrl: string; colors: Colors }) {
  return <Blocks blocks={blocks} context={{ reviewId, projectUrl, colors, color: colors.foreground }} />;
}

function Blocks({ blocks, context }: { blocks: readonly Block[]; context: Context }) {
  return (
    <View style={{ gap: spacing[2] }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} context={context} />
      ))}
    </View>
  );
}

function BlockView({ block, context }: { block: Block; context: Context }) {
  const { colors } = context;
  switch (block.kind) {
    case "heading": {
      const size = block.level === 1 ? fontSize.xl : block.level === 2 ? fontSize.lg : fontSize.base;
      return (
        <Text selectable accessibilityRole="header" style={{ color: context.color, fontSize: size, lineHeight: leading(size), fontWeight: "600" }}>
          <Spans spans={block.spans} context={context} />
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text selectable style={{ color: context.color, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
          <Spans spans={block.spans} context={context} />
        </Text>
      );
    case "image":
      return <DescriptionImage block={block} context={context} />;
    case "list":
      return (
        <View style={{ gap: spacing[1] }}>
          {block.items.map((item, index) => (
            <Item key={index} item={item} marker={item.task !== null ? (item.task === "done" ? "☑" : "☐") : block.ordered ? `${block.start + index}.` : "•"} context={context} />
          ))}
        </View>
      );
    case "quote":
      return (
        <View style={{ borderLeftWidth: 3, borderColor: colors.border, paddingLeft: spacing[3] }}>
          <Blocks blocks={block.blocks} context={{ ...context, color: colors.foregroundMuted }} />
        </View>
      );
    case "code":
      return (
        <ScrollView horizontal style={{ backgroundColor: colors.surface2, borderRadius: radius.md }} contentContainerStyle={{ padding: spacing[2] }}>
          <Text selectable style={{ fontFamily: MONO_FONT, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), color: colors.foreground }}>
            {block.text}
          </Text>
        </ScrollView>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: spacing[1] }} />;
    case "table":
      return <Table align={block.align} header={block.header} rows={block.rows} context={context} />;
    case "details":
      return <Details summary={block.summary} blocks={block.blocks} context={context} />;
    case "html":
      return (
        <Text selectable style={{ fontFamily: MONO_FONT, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), color: colors.foregroundMuted }}>
          {block.text}
        </Text>
      );
  }
}

/** Runs of text inside the `Text` that styles their block; a link opens in the browser. */
function Spans({ spans, context }: { spans: readonly Span[]; context: Context }) {
  const { colors } = context;
  return (
    <>
      {spans.map((span, index) => {
        const target = span.href === undefined ? null : linkTarget(span.href, context.projectUrl);
        return (
          <Text
            key={index}
            {...(target === null ? {} : { accessibilityRole: "link" as const, onPress: () => void openLink(target) })}
            style={{
              ...(span.strong ? { fontWeight: "600" as const } : {}),
              ...(span.emphasis ? { fontStyle: "italic" as const } : {}),
              ...(span.strike ? { textDecorationLine: "line-through" as const } : {}),
              ...(span.code ? { fontFamily: MONO_FONT, fontSize: fontSize.sm, backgroundColor: colors.surface2, borderRadius: radius.md } : {}),
              ...(target === null ? {} : { color: colors.accent }),
            }}
          >
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

function Item({ item, marker, context }: { item: ListItem; marker: string; context: Context }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing[2] }}>
      <Text style={{ color: context.colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{marker}</Text>
      <View style={{ flex: 1 }}>
        <Blocks blocks={item.blocks} context={context} />
      </View>
    </View>
  );
}

/** Cells cannot measure each other, so a column is as wide as its longest text suggests, within bounds, and the table scrolls sideways. */
const CHARACTER_WIDTH = 7;
const COLUMN_WIDTH = { min: 64, max: 320 };

function Table({ align, header, rows, context }: { align: readonly Align[]; header: Span[][]; rows: Span[][][]; context: Context }) {
  const { colors } = context;
  const columns = Math.max(header.length, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => {
    const longest = Math.max(0, ...[header, ...rows].map((row) => (row[column] ?? []).reduce((length, span) => length + span.text.length, 0)));
    return Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, longest * CHARACTER_WIDTH + spacing[4]));
  });
  const row = (cells: Span[][], key: string, head: boolean) => (
    <View key={key} style={{ flexDirection: "row", borderTopWidth: head ? 0 : 1, borderColor: colors.border, backgroundColor: head ? colors.surface2 : undefined }}>
      {widths.map((width, column) => (
        <View key={column} style={{ width, padding: spacing[2] }}>
          <Text
            selectable
            style={{
              color: context.color,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
              textAlign: align[column] ?? "left",
              ...(head ? { fontWeight: "600" as const } : {}),
            }}
          >
            <Spans spans={cells[column] ?? []} context={context} />
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}>
        {header.length > 0 ? row(header, "header", true) : null}
        {rows.map((cells, index) => row(cells, String(index), false))}
      </View>
    </ScrollView>
  );
}

/** Folded, as the forges show it. */
function Details({ summary, blocks, context }: { summary: Span[]; blocks: Block[]; context: Context }) {
  const [open, setOpen] = useState(false);
  const { colors } = context;
  return (
    <View style={{ gap: spacing[2] }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: "row", gap: spacing[2] }}>
        <Text style={{ width: spacing[3], color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{open ? "▾" : "▸"}</Text>
        <Text style={{ flex: 1, color: context.color, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
          <Spans spans={summary} context={context} />
        </Text>
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: spacing[3] + spacing[2] }}>
          <Blocks blocks={blocks} context={context} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * An image the daemon fetched with the forge's login, at the size the author gave it or its own,
 * never wider than the pane; one it could not give is a link to open in the browser instead.
 */
function DescriptionImage({ block, context }: { block: ImageBlock; context: Context }) {
  const { reviewId, colors } = context;
  const url = linkTarget(block.src, context.projectUrl);
  const getImage = useRpc(contracts.getDescriptionImage);
  const query = useQuery({
    queryKey: [PLUGIN_ID, "description-image", reviewId, url],
    queryFn: () => getImage({ reviewId, url: url! }),
    enabled: url !== null,
    staleTime: Infinity,
  });
  const name = block.alt.trim() || fileName(block.src);
  const label = `Image: ${name}`;
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };

  if (url !== null && query.isPending) return <Text style={muted}>Loading the image {name}…</Text>;
  const image = query.data;
  if (url !== null && image?.status === "image") {
    const ratio = image.width / image.height;
    const width = block.width ?? (block.height === null ? image.width : block.height * ratio);
    return (
      <View style={{ alignItems: "flex-start" }}>
        <Image
          source={{ uri: `data:${image.mimeType};base64,${image.base64}` }}
          accessibilityLabel={block.alt}
          resizeMode="contain"
          style={{ width, maxWidth: "100%", aspectRatio: ratio, borderRadius: radius.md }}
        />
      </View>
    );
  }
  const reason =
    url === null
      ? "It has no address to open."
      : image?.status === "unavailable"
        ? image.message
        : query.error instanceof Error
          ? query.error.message
          : String(query.error ?? "");
  return (
    <Text style={muted}>
      {url === null ? (
        label
      ) : (
        <Text accessibilityRole="link" onPress={() => void openLink(url)} style={{ color: colors.accent }}>
          {label}
        </Text>
      )}
      {reason === "" ? null : ` — ${reason}`}
    </Text>
  );
}

function fileName(src: string): string {
  const last = src.split(/[?#]/)[0]!.split("/").filter(Boolean).at(-1) ?? "image";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
