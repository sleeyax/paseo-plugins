import { access, readFile } from "node:fs/promises";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** A project's files are the user's to break, so unreadable or malformed reads as absent. */
async function readObject(path: string, toJson: (text: string) => string): Promise<JsonObject | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(toJson(text));
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function readJsonObject(path: string): Promise<JsonObject | null> {
  return readObject(path, (text) => text);
}

/** The end of the JSON string that opens at `start`, past its closing quote. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

function stripJsonc(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (char === '"') {
      const end = stringEnd(text, index);
      result += text.slice(index, end);
      index = end;
    } else if (char === "/" && next === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
    } else if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
    } else {
      if (char === "}" || char === "]") {
        const trimmed = result.trimEnd();
        if (trimmed.endsWith(",")) result = trimmed.slice(0, -1);
      }
      result += char;
      index += 1;
    }
  }
  return result;
}

export function readJsoncObject(path: string): Promise<JsonObject | null> {
  return readObject(path, stripJsonc);
}

export function stringEntries(value: unknown): [string, string][] {
  if (!isJsonObject(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}
