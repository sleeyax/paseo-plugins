import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { taskSchema, type Task } from "../../shared/task.ts";

const KEPT_PER_WORKSPACE = 10;

const historySchema = z.record(z.string(), z.array(taskSchema));
type History = z.infer<typeof historySchema>;

export type TaskHistory = {
  /** Most recent first. */
  read(workspaceId: string): Promise<Task[]>;
  record(workspaceId: string, task: Task): Promise<void>;
};

/** Keeps the whole task, so the last one can run again without a rescan. */
export function createTaskHistory(path: string): TaskHistory {
  const load = async (): Promise<History> => {
    try {
      return historySchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return {};
    }
  };

  // Records are chained so two runs started together cannot overwrite each other's entry.
  let writes: Promise<void> = Promise.resolve();

  return {
    async read(workspaceId) {
      await writes;
      return (await load())[workspaceId] ?? [];
    },
    record(workspaceId, task) {
      writes = writes.then(async () => {
        const history = await load();
        const others = (history[workspaceId] ?? []).filter((entry) => entry.id !== task.id);
        history[workspaceId] = [task, ...others].slice(0, KEPT_PER_WORKSPACE);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(history));
        await rename(`${path}.tmp`, path);
      });
      return writes;
    },
  };
}
