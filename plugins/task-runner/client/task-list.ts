import type { Task } from "../shared/task.ts";

export type TaskGroup = { name: string; tasks: Task[] };

export function filterTasks(tasks: Task[], query: string): Task[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tasks;
  return tasks.filter((task) => {
    const haystack = `${task.label} ${task.group} ${task.source}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function groupTasks(tasks: Task[]): TaskGroup[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) groups.set(task.group, [...(groups.get(task.group) ?? []), task]);
  return [...groups].map(([name, grouped]) => ({ name, tasks: grouped }));
}
