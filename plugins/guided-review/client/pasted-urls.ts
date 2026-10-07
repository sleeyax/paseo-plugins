/** The URLs pasted into New review, one per line: each line trimmed, blank lines and repeats left out. */
export function pastedUrls(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()))].filter((line) => line !== "");
}
