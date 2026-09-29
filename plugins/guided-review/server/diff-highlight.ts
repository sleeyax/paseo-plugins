import { darkHighlightColors, highlightCode, isLanguageSupported, lightHighlightColors } from "@getpaseo/highlight";
import type { SyntaxColors } from "../shared/contracts.ts";
import type { DiffLine, FileDiff, SyntaxToken } from "../shared/diff.ts";
import { parsePatch } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/** Paseo's diff highlighter skips a file with a line longer than this, which would take the parser long for nothing. */
const MAX_LINE_CHARS = 10_000;

/** Files whose tokens are kept, so the nodes that share a file do not highlight it again. */
const CACHED_FILES = 200;

/** A file's text at a commit, or null when it cannot be read there. */
export type FileAt = (sha: string, path: string) => Promise<string | null>;

/** One side of a file, old or new, as tokens by line number. */
type SideTokens = Map<number, SyntaxToken[]>;
type FileTokens = { old: SideTokens; new: SideTokens };

/** The palettes of Paseo's default syntax theme. */
export function syntaxColors(): SyntaxColors {
  return { dark: darkHighlightColors, light: lightHighlightColors };
}

/**
 * Syntax tokens for the lines of a review's diffs, as Paseo's own diff highlighter makes them: each
 * side of a file is highlighted whole, from the file at the base or head where git has it and its
 * lines are the diff's, and otherwise from the text the file's hunks give, so a comment or string
 * that opens above a line still colours it.
 */
export class DiffHighlighter {
  readonly #cache = new Map<string, Promise<FileTokens | null>>();

  /**
   * `diffs` with tokens on their lines. `key` names the review and head the files were read at, and
   * `changed` holds the whole of each file's diff, which is highlighted rather than the lines shown.
   */
  async highlight(
    key: string,
    diffs: readonly FileDiff[],
    changed: readonly ChangedFile[],
    sides: { baseSha: string; headSha: string; fileAt: FileAt },
  ): Promise<FileDiff[]> {
    const byPath = new Map(changed.map((file) => [file.path, file]));
    return Promise.all(
      diffs.map(async (diff) => {
        const file = byPath.get(diff.path);
        const tokens = file === undefined ? null : await this.#tokens(`${key}:${diff.path}`, file, sides);
        return tokens === null ? diff : withTokens(diff, tokens);
      }),
    );
  }

  #tokens(key: string, file: ChangedFile, sides: { baseSha: string; headSha: string; fileAt: FileAt }): Promise<FileTokens | null> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const tokens = fileTokens(file, sides).catch(() => null);
    this.#cache.set(key, tokens);
    if (this.#cache.size > CACHED_FILES) this.#cache.delete(this.#cache.keys().next().value!);
    return tokens;
  }
}

async function fileTokens(file: ChangedFile, { baseSha, headSha, fileAt }: { baseSha: string; headSha: string; fileAt: FileAt }): Promise<FileTokens | null> {
  if (file.patch === null || !isLanguageSupported(file.path)) return null;
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  for (const hunk of parsePatch(file.patch)) {
    for (const line of hunk.lines) {
      if (line.text.length > MAX_LINE_CHARS) return null;
      if (line.oldLine !== null) oldLines.set(line.oldLine, line.text);
      if (line.newLine !== null) newLines.set(line.newLine, line.text);
    }
  }
  const [oldText, newText] = await Promise.all([
    file.status === "added" ? null : fileAt(baseSha, file.previousPath ?? file.path),
    file.status === "removed" ? null : fileAt(headSha, file.path),
  ]);
  return {
    old: fromFile(oldText, oldLines, file.path) ?? fromHunks(oldLines, file.path),
    new: fromFile(newText, newLines, file.path) ?? fromHunks(newLines, file.path),
  };
}

/**
 * A side highlighted from the whole file, when every line the diff has of it is there: on GitHub the
 * base is the base branch's tip, which may have moved on since the merge base the diff was taken from.
 */
function fromFile(text: string | null, expected: ReadonlyMap<number, string>, path: string): SideTokens | null {
  if (text === null) return null;
  const lines = text.split("\n");
  for (const [number, line] of expected) if (lines[number - 1] !== line) return null;
  if (lines.some((line) => line.length > MAX_LINE_CHARS)) return null;
  return new Map(highlightCode(text, path).map((tokens, index) => [index + 1, tokens]));
}

/** A side highlighted from the lines the hunks give of it, in place, with blanks between hunks. */
function fromHunks(lines: ReadonlyMap<number, string>, path: string): SideTokens {
  if (lines.size === 0) return new Map();
  const numbers = [...lines.keys()];
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const text = Array.from({ length: last - first + 1 }, (_, index) => lines.get(first + index) ?? "").join("\n");
  const tokens = new Map<number, SyntaxToken[]>();
  highlightCode(text, path).forEach((line, index) => {
    if (lines.has(first + index)) tokens.set(first + index, line);
  });
  return tokens;
}

/** A context line is in both sides, and takes the new one's tokens, as Paseo's do. */
function withTokens(diff: FileDiff, tokens: FileTokens): FileDiff {
  const tokensOf = (line: DiffLine) => (line.kind === "removed" ? tokens.old.get(line.oldLine!) : tokens.new.get(line.newLine!));
  return {
    ...diff,
    hunks: diff.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => {
        const found = tokensOf(line);
        return found !== undefined && found.map((token) => token.text).join("") === line.text ? { ...line, tokens: found } : line;
      }),
    })),
  };
}
