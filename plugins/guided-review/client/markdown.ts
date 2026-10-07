// The standalone build, with its dependencies inlined: Paseo's client compiler resolves only packages with an `exports` map, which its `punycode.js` lacks.
import MarkdownIt from "markdown-it/dist/markdown-it.js";
import type Token from "markdown-it/lib/token.mjs";

/** A run of text and the marks on it; a line break is a run of "\n". */
export type Span = { text: string; strong?: true; emphasis?: true; strike?: true; code?: true; href?: string };

/** `width` and `height` are an `<img>`'s own attributes, which the author set to size it. */
export type ImageBlock = { kind: "image"; src: string; alt: string; width: number | null; height: number | null };

export type Align = "left" | "center" | "right" | null;

export type ListItem = { task: "open" | "done" | null; blocks: Block[] };

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | ImageBlock
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "table"; align: Align[]; header: Span[][]; rows: Span[][][] }
  | { kind: "details"; summary: Span[]; blocks: Block[] }
  /** HTML the panel does not draw, shown as the author wrote it. */
  | { kind: "html"; text: string };

// Both forges break a description's lines where the author did, and link bare URLs.
const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });

/** A PR/MR description as blocks the panel draws itself, since Paseo hands plugins no Markdown renderer. */
export function parseMarkdown(source: string): Block[] {
  return blocksOf(markdown.parse(source, {}), 0, null)[0];
}

/**
 * Where a link or image in the description points: absolute, or relative to the project's web URL,
 * which is how GitLab writes an upload. Null for an in-page anchor and any scheme a browser should
 * not be handed from someone else's text.
 */
export function linkTarget(href: string, projectUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return /^(https?|mailto):/i.test(trimmed) ? trimmed : null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `${projectUrl}/${trimmed.replace(/^\.?\//, "")}`;
}

type DetailsFrame = { summary: Span[]; blocks: Block[] };

/** The blocks from `from` up to the `close` token, and the index after it. */
function blocksOf(tokens: Token[], from: number, close: string | null): [Block[], number] {
  const root: Block[] = [];
  // An HTML block opens a `<details>` that a later one closes, with Markdown between them.
  const open: DetailsFrame[] = [];
  const target = () => open.at(-1)?.blocks ?? root;
  const closeDetails = () => {
    const frame = open.pop()!;
    target().push({ kind: "details", summary: frame.summary, blocks: frame.blocks });
  };

  let index = from;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === close) return [finish(), index + 1];
    switch (token.type) {
      case "heading_open":
        target().push(...withImages({ kind: "heading", level: Number(token.tag.slice(1)), spans: [] }, tokens[index + 1]!));
        index += 3;
        break;
      case "paragraph_open":
        target().push(...withImages({ kind: "paragraph", spans: [] }, tokens[index + 1]!));
        index += 3;
        break;
      case "bullet_list_open":
      case "ordered_list_open": {
        const [items, next] = itemsOf(tokens, index + 1, token.type.replace("_open", "_close"));
        target().push({ kind: "list", ordered: token.type === "ordered_list_open", start: Number(token.attrGet("start") ?? 1), items });
        index = next;
        break;
      }
      case "blockquote_open": {
        const [blocks, next] = blocksOf(tokens, index + 1, "blockquote_close");
        target().push({ kind: "quote", blocks });
        index = next;
        break;
      }
      case "fence":
      case "code_block":
        target().push({ kind: "code", text: token.content.replace(/\n$/, "") });
        index += 1;
        break;
      case "hr":
        target().push({ kind: "rule" });
        index += 1;
        break;
      case "table_open": {
        const [table, next] = tableOf(tokens, index + 1);
        target().push(table);
        index = next;
        break;
      }
      case "html_block":
        html(token.content);
        index += 1;
        break;
      default:
        index += 1;
    }
  }
  return [finish(), index];

  function finish(): Block[] {
    while (open.length > 0) closeDetails();
    return root;
  }

  function html(content: string) {
    const opening = /^\s*<details\b[^>]*>/i.exec(content);
    if (opening !== null) {
      let rest = content.slice(opening[0].length);
      const summary = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(rest);
      if (summary !== null) rest = rest.slice(summary[0].length);
      const frame: DetailsFrame = { summary: summary === null ? [{ text: "Details" }] : inlineSpans(summary[1]!.trim()), blocks: [] };
      const closing = /<\/details>/i.exec(rest);
      if (closing === null) {
        frame.blocks.push(...parseMarkdown(rest));
        open.push(frame);
        return;
      }
      frame.blocks.push(...parseMarkdown(rest.slice(0, closing.index)));
      target().push({ kind: "details", summary: frame.summary, blocks: frame.blocks });
      target().push(...parseMarkdown(rest.slice(closing.index + closing[0].length)));
      return;
    }
    const closing = /^\s*<\/details>/i.exec(content);
    if (closing !== null && open.length > 0) {
      closeDetails();
      target().push(...parseMarkdown(content.slice(closing[0].length)));
      return;
    }
    const images = imagesIn(content);
    target().push(...(images ?? [{ kind: "html", text: content.replace(/\n+$/, "") }]));
  }
}

function itemsOf(tokens: Token[], from: number, close: string): [ListItem[], number] {
  const items: ListItem[] = [];
  let index = from;
  while (index < tokens.length && tokens[index]!.type !== close) {
    if (tokens[index]!.type !== "list_item_open") {
      index += 1;
      continue;
    }
    const [blocks, next] = blocksOf(tokens, index + 1, "list_item_close");
    items.push(taskItem(blocks));
    index = next;
  }
  return [items, index + 1];
}

/** A list item whose text opens with `[ ]` or `[x]` is a task, as both forges draw it. */
function taskItem(blocks: Block[]): ListItem {
  const first = blocks[0];
  const span = first?.kind === "paragraph" ? first.spans[0] : undefined;
  const box = span === undefined || span.code ? null : /^\[([ xX])\](?:\s+|$)/.exec(span.text);
  if (first?.kind !== "paragraph" || span === undefined || box === null) return { task: null, blocks };
  const spans = [{ ...span, text: span.text.slice(box[0].length) }, ...first.spans.slice(1)].filter((each) => each.text !== "");
  return { task: box[1] === " " ? "open" : "done", blocks: [{ ...first, spans }, ...blocks.slice(1)] };
}

function tableOf(tokens: Token[], from: number): [Block, number] {
  const align: Align[] = [];
  const header: Span[][] = [];
  const rows: Span[][][] = [];
  let row: Span[][] | null = null;
  let inHead = false;
  let index = from;
  for (; index < tokens.length && tokens[index]!.type !== "table_close"; index += 1) {
    const token = tokens[index]!;
    if (token.type === "thead_open") inHead = true;
    else if (token.type === "thead_close") inHead = false;
    else if (token.type === "tr_open") row = inHead ? header : [];
    else if (token.type === "tr_close" && row !== null && !inHead) rows.push(row);
    else if ((token.type === "th_open" || token.type === "td_open") && row !== null) {
      if (inHead) align.push(alignOf(token.attrGet("style")));
      row.push(spansOf(tokens[index + 1]?.children ?? []).flatMap((part) => ("kind" in part ? [{ text: part.alt }] : [part])));
    }
  }
  return [{ kind: "table", align, header, rows }, index + 1];
}

function alignOf(style: string | null): Align {
  const match = /text-align:\s*(left|center|right)/.exec(style ?? "");
  return match === null ? null : (match[1] as Align);
}

/**
 * A heading's or paragraph's inline content, split where an image sits, since an image cannot be
 * drawn inside a run of text.
 */
function withImages(block: { kind: "heading"; level: number; spans: Span[] } | { kind: "paragraph"; spans: Span[] }, inline: Token): Block[] {
  const blocks: Block[] = [];
  let spans: Span[] = [];
  const flush = () => {
    const trimmed = trimBreaks(spans);
    if (trimmed.length > 0) blocks.push({ ...block, spans: trimmed });
    spans = [];
  };
  for (const part of spansOf(inline.children ?? [])) {
    if ("kind" in part) {
      flush();
      blocks.push(part);
    } else {
      spans.push(part);
    }
  }
  flush();
  return blocks;
}

function trimBreaks(spans: Span[]): Span[] {
  let start = 0;
  let end = spans.length;
  while (start < end && spans[start]!.text.trim() === "" && !spans[start]!.code) start += 1;
  while (end > start && spans[end - 1]!.text.trim() === "" && !spans[end - 1]!.code) end -= 1;
  return spans.slice(start, end);
}

function inlineSpans(source: string): Span[] {
  const [token] = markdown.parseInline(source, {});
  return spansOf(token?.children ?? []).flatMap((part) => ("kind" in part ? [{ text: part.alt }] : [part]));
}

function spansOf(children: Token[]): (Span | ImageBlock)[] {
  const parts: (Span | ImageBlock)[] = [];
  const marks = { strong: 0, emphasis: 0, strike: 0 };
  const links: string[] = [];
  const span = (text: string, code = false): Span => ({
    text,
    ...(marks.strong > 0 ? { strong: true as const } : {}),
    ...(marks.emphasis > 0 ? { emphasis: true as const } : {}),
    ...(marks.strike > 0 ? { strike: true as const } : {}),
    ...(code ? { code: true as const } : {}),
    ...(links.length > 0 ? { href: links.at(-1)! } : {}),
  });
  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.content !== "") parts.push(span(child.content));
        break;
      case "code_inline":
        parts.push(span(child.content, true));
        break;
      case "softbreak":
      case "hardbreak":
        parts.push(span("\n"));
        break;
      case "strong_open":
      case "strong_close":
        marks.strong += child.nesting;
        break;
      case "em_open":
      case "em_close":
        marks.emphasis += child.nesting;
        break;
      case "s_open":
      case "s_close":
        marks.strike += child.nesting;
        break;
      case "link_open":
        links.push(child.attrGet("href") ?? "");
        break;
      case "link_close":
        links.pop();
        break;
      case "image":
        parts.push({ kind: "image", src: child.attrGet("src") ?? "", alt: child.content, width: null, height: null });
        break;
      case "html_inline":
        if (/^<br\s*\/?>$/i.test(child.content)) parts.push(span("\n"));
        else parts.push(...(imagesIn(child.content) ?? [span(child.content)]));
        break;
    }
  }
  return parts;
}

/** The images of HTML that holds nothing else but line breaks, which is how GitHub inserts a pasted screenshot; null for any other HTML. */
function imagesIn(html: string): ImageBlock[] | null {
  const images: ImageBlock[] = [];
  const rest = html.replace(/<img\b([^>]*)>/gi, (_, attributes: string) => {
    const read = attributesOf(attributes);
    images.push({ kind: "image", src: read.get("src") ?? "", alt: read.get("alt") ?? "", width: pixels(read.get("width")), height: pixels(read.get("height")) });
    return "";
  });
  if (images.length === 0 || rest.replace(/<br\s*\/?>/gi, "").trim() !== "") return null;
  return images;
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) {
    attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** A size in pixels; a percentage or anything else says nothing the panel can use. */
function pixels(value: string | undefined): number | null {
  const match = /^\s*(\d+)(?:px)?\s*$/.exec(value ?? "");
  return match === null ? null : Number(match[1]);
}
