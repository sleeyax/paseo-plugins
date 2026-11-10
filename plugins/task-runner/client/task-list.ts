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

const RECENT_SHOWN = 5;

export type TaskSectionRow = {
  task: Task;
  /** The row's place in the keyboard order. */
  index: number;
  /** Whether the row sits outside its group, so its group needs naming. */
  showGroup: boolean;
};

export type TaskSection = {
  key: string;
  /** Null for the only group, which needs no header. */
  title: string | null;
  collapsible: boolean;
  open: boolean;
  rows: TaskSectionRow[];
};

export type SectionOptions = {
  query: string;
  recentIds: string[];
  /** Section keys, so a package named Recent does not share the Recent section's state. */
  collapsed: ReadonlySet<string>;
};

export function buildSections(tasks: Task[], { query, recentIds, collapsed }: SectionOptions): { sections: TaskSection[]; navigable: Task[] } {
  const shown = filterTasks(tasks, query);
  const grouped = groupTasks(tasks).length > 1;
  const searching = query.trim() !== "";
  const navigable: Task[] = [];
  const rowsOf = (sectionTasks: Task[], showGroup: boolean) =>
    sectionTasks.map((task) => {
      navigable.push(task);
      return { task, index: navigable.length - 1, showGroup };
    });

  const sections: TaskSection[] = [];
  const isOpen = (key: string) => searching || !collapsed.has(key);
  const recent = recentIds.flatMap((id) => shown.find((task) => task.id === id) ?? []).slice(0, RECENT_SHOWN);
  if (recent.length > 0) {
    const open = isOpen("recent");
    sections.push({ key: "recent", title: "Recent", collapsible: true, open, rows: open ? rowsOf(recent, grouped) : [] });
  }
  for (const group of groupTasks(shown)) {
    const key = `group:${group.name}`;
    const open = isOpen(key);
    sections.push({ key, title: grouped ? group.name : null, collapsible: grouped, open, rows: open ? rowsOf(group.tasks, false) : [] });
  }
  return { sections, navigable };
}
