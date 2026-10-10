/**
 * Whether a shell command only reads, for a guide agent that may look around the checkout but never
 * change it. Anything not recognised is not read-only: a pipeline or list of known programs, with no
 * substitution, subshell, background job, heredoc or redirect other than to `/dev/null` or another
 * descriptor, and none of the options with which a known program writes a file or runs another.
 * Such a program also takes no unquoted glob, since a file in the checkout named like one of those
 * options, which a change can add, would become that option.
 */
export function readOnlyCommand(command: string): boolean {
  const segments = lex(command);
  return segments !== null && segments.length > 0 && segments.every(readOnlySegment);
}

/** `git` subcommands that read the repository and nothing else. */
const GIT_READS = new Set(["log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "merge-base", "cat-file", "shortlog", "status"]);

/** Each program, and the arguments that would make it write or run something; null when there are none. */
const PROGRAMS: Record<string, ((arg: string) => boolean) | null> = {
  cat: null,
  cd: null,
  cut: null,
  echo: null,
  file: (arg) => /^-[^-]*C/.test(arg),
  find: (arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg),
  grep: null,
  head: null,
  jq: null,
  ls: null,
  pwd: null,
  rg: (arg) => /^--pre(=|$)/.test(arg),
  sort: (arg) => /^-[^-]*o/.test(arg) || /^--(output|compress-program)(=|$)/.test(arg),
  stat: null,
  tail: null,
  tr: null,
  tree: (arg) => /^-[^-]*o/.test(arg),
  wc: null,
};

type Word = { text: string; glob: boolean };

function readOnlySegment(words: Word[]): boolean {
  const [program, ...rest] = words;
  if (program === undefined || program.glob) return false;
  const args = rest.map((word) => word.text);
  const guarded = program.text === "git" || (Object.hasOwn(PROGRAMS, program.text) && PROGRAMS[program.text] !== null);
  if (guarded && rest.some((word) => word.glob)) return false;
  if (program.text === "git") return readOnlyGit(args);
  if (!Object.hasOwn(PROGRAMS, program.text)) return false;
  const writes = PROGRAMS[program.text];
  return writes === null || writes === undefined || !args.some(writes);
}

function readOnlyGit(args: string[]): boolean {
  let index = 0;
  // `-c` and `--exec-path` among git's own options would let a command run anything.
  while (index < args.length && args[index]!.startsWith("-")) {
    const option = args[index]!;
    if (option === "-C") index += 2;
    else if (option === "--no-pager" || option === "-P" || option === "--no-optional-locks") index += 1;
    else return false;
  }
  const subcommand = args[index];
  if (subcommand === undefined || !GIT_READS.has(subcommand)) return false;
  return !args.slice(index + 1).some((arg) => /^--(output|ext-diff|open-files-in-pager)(=|$)/.test(arg) || /^-O/.test(arg));
}

/**
 * The command's segments, split on `|`, `||`, `&&`, `;` and newlines, each as its words with quotes
 * removed; null for anything this does not follow, which then counts as not read-only.
 */
function lex(command: string): Word[][] | null {
  const segments: Word[][] = [[]];
  let word = null as Word | null;
  const append = (text: string, glob = false) => {
    word = { text: (word?.text ?? "") + text, glob: (word?.glob ?? false) || glob };
  };
  const endWord = () => {
    if (word !== null) segments.at(-1)!.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (segments.at(-1)!.length === 0) return false;
    segments.push([]);
    return true;
  };
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      append(command.slice(index + 1, end));
      index = end + 1;
    } else if (char === '"') {
      let text = "";
      index += 1;
      while (index < command.length && command[index] !== '"') {
        const inner = command[index]!;
        if (inner === "`" || (inner === "$" && command[index + 1] === "(")) return null;
        if (inner === "\\" && index + 1 < command.length) {
          text += command[index + 1];
          index += 2;
        } else {
          text += inner;
          index += 1;
        }
      }
      if (index >= command.length) return null;
      append(text);
      index += 1;
    } else if (char === "\\") {
      if (next === undefined) return null;
      if (next !== "\n") append(next);
      index += 2;
    } else if (char === " " || char === "\t") {
      endWord();
      index += 1;
    } else if (char === "\n" || char === ";") {
      if (!endSegment()) return null;
      index += 1;
    } else if (char === "|") {
      if (!endSegment()) return null;
      index += next === "|" ? 2 : 1;
    } else if (char === "&") {
      if (next !== "&" || !endSegment()) return null;
      index += 2;
    } else if (char === ">") {
      // A descriptor number written against the `>` is part of the redirect, not a word.
      if (word !== null && /^[0-9]$/.test(word.text)) word = null;
      endWord();
      index += 1;
      if (command[index] === ">") index += 1;
      const duplicate = command[index] === "&";
      if (duplicate) index += 1;
      while (command[index] === " " || command[index] === "\t") index += 1;
      const target = /^[^\s;&|<>()`$'"\\]+/.exec(command.slice(index))?.[0];
      if (target === undefined || !(duplicate ? /^[0-9]$/.test(target) : target === "/dev/null")) return null;
      index += target.length;
    } else if (char === "<") {
      if (next === "<" || next === "(") return null;
      endWord();
      index += 1;
      while (command[index] === " " || command[index] === "\t") index += 1;
    } else if (char === "`" || char === "(" || char === ")" || (char === "$" && next === "(")) {
      return null;
    } else if (char === "#" && word === null) {
      return null;
    } else {
      append(char, char === "*" || char === "?" || char === "[");
      index += 1;
    }
  }
  endWord();
  if (segments.at(-1)!.length === 0) segments.pop();
  // A leading `NAME=value` sets the environment of the program after it, which can change what it runs.
  if (segments.some((words) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text))) return null;
  return segments;
}
