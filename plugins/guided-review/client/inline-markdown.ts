/** A run of guide text and the inline Markdown marks on it. */
export type Span = { text: string; code?: true; strong?: true; emphasis?: true };

type Marks = Omit<Span, "text">;

type Delimiter = { token: string; mark: "strong" | "emphasis"; opensAt: (text: string, at: number) => boolean; closesAt: (text: string, at: number) => boolean };

const WORD = /[\p{L}\p{N}]/u;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char);
const isBlank = (char: string | undefined) => char === undefined || /\s/.test(char);

const DELIMITERS: readonly Delimiter[] = [
  { token: "**", mark: "strong", opensAt: (text, at) => !isBlank(text[at + 2]), closesAt: (text, at) => !isBlank(text[at - 1]) },
  {
    token: "*",
    mark: "emphasis",
    opensAt: (text, at) => text[at + 1] !== "*" && !isBlank(text[at + 1]),
    closesAt: (text, at) => text[at - 1] !== "*" && text[at + 1] !== "*" && !isBlank(text[at - 1]),
  },
  // An underscore inside a word, as in snake_case, is part of the word.
  {
    token: "_",
    mark: "emphasis",
    opensAt: (text, at) => !isWord(text[at - 1]) && !isBlank(text[at + 1]),
    closesAt: (text, at) => !isBlank(text[at - 1]) && !isWord(text[at + 1]),
  },
];

/**
 * The inline Markdown the guide agent writes: code spans, `**strong**`, and `*emphasis*` or `_emphasis_`, nested.
 * Anything else, an unclosed delimiter included, is literal text.
 */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  parse(text, {}, spans);
  return spans;
}

function parse(text: string, marks: Marks, into: Span[]): void {
  let literal = "";
  const flush = () => {
    if (literal !== "") into.push({ text: literal, ...marks });
    literal = "";
  };
  let at = 0;
  while (at < text.length) {
    if (text[at] === "`") {
      const run = backtickRun(text, at);
      const close = closingRun(text, at + run, run);
      if (close === -1) {
        literal += text.slice(at, at + run);
      } else {
        flush();
        into.push({ text: codeContent(text.slice(at + run, close)), ...marks, code: true });
      }
      at = close === -1 ? at + run : close + run;
      continue;
    }
    const found = emphasisAt(text, at);
    if (found !== null) {
      flush();
      parse(text.slice(at + found.delimiter.token.length, found.close), { ...marks, [found.delimiter.mark]: true }, into);
      at = found.close + found.delimiter.token.length;
      continue;
    }
    literal += text[at];
    at += 1;
  }
  flush();
}

function emphasisAt(text: string, at: number): { delimiter: Delimiter; close: number } | null {
  for (const delimiter of DELIMITERS) {
    const { token } = delimiter;
    if (!text.startsWith(token, at) || !delimiter.opensAt(text, at)) continue;
    let close = at + token.length + 1;
    while (close < text.length) {
      if (text[close] === "`") {
        const run = backtickRun(text, close);
        const end = closingRun(text, close + run, run);
        close = end === -1 ? close + run : end + run;
        continue;
      }
      if (text.startsWith(token, close) && delimiter.closesAt(text, close)) return { delimiter, close };
      close += 1;
    }
  }
  return null;
}

function backtickRun(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") end += 1;
  return end - at;
}

/** Where a run of exactly `length` backticks starts at or after `from`, or -1. */
function closingRun(text: string, from: number, length: number): number {
  let at = from;
  while (at < text.length) {
    if (text[at] !== "`") {
      at += 1;
      continue;
    }
    const run = backtickRun(text, at);
    if (run === length) return at;
    at += run;
  }
  return -1;
}

/** CommonMark's code span content: line breaks read as spaces, and one space each side is padding when both are there. */
function codeContent(raw: string): string {
  const content = raw.replace(/\r?\n/g, " ");
  return content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "" ? content.slice(1, -1) : content;
}

/** Guide text with its Markdown read and dropped, for where it goes into a sentence of the plugin's own. */
export function plainText(text: string): string {
  return parseInline(text)
    .map((span) => span.text)
    .join("");
}
