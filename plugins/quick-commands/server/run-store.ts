import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { lastRunsSchema, type LastRuns } from "../shared/runs.ts";

export interface RunStore {
  load(): Promise<LastRuns>;
  save(runs: LastRuns): Promise<void>;
}

/** Last runs in one JSON file. */
export function createRunStore(file: string, log: (message: string) => void = console.warn): RunStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`could not read ${file}: ${String(error)}`);
        return {};
      }
      const parsed = lastRunsSchema.safeParse(safeJson(text));
      if (!parsed.success) {
        log(`ignoring unreadable ${file}`);
        return {};
      }
      return parsed.data;
    },
    async save(runs) {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(runs, null, 2));
      await rename(temporary, file);
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
