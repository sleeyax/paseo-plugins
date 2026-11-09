import assert from "node:assert/strict";
import { access, chmod } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Task } from "../../shared/task.ts";
import { discoverTasks } from "./discover.ts";
import { InferredTargets } from "./inferred-targets.ts";
import { writeTree } from "./test-tree.ts";

const labels = (tasks: Task[]) => tasks.map((task) => task.label);
const byLabel = (tasks: Task[], label: string) => {
  const task = tasks.find((candidate) => candidate.label === label);
  assert.ok(task, `no task labelled ${label} in ${labels(tasks).join(", ")}`);
  return task;
};

describe("package.json scripts", () => {
  it("lists scripts in the workspace root, grouped under the package's name", async () => {
    const root = await writeTree({ "package.json": { name: "shop", scripts: { build: "tsc", dev: "vite" } } });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(labels(tasks), ["build", "dev"]);
    assert.deepEqual(byLabel(tasks, "build"), {
      id: "task: build",
      label: "build",
      group: "shop",
      source: "npm",
      command: "npm",
      args: ["run", "build"],
      cwd: root,
      description: null,
      disabledReason: null,
    });
  });

  it("names the root group after the directory when package.json has no name", async () => {
    const root = await writeTree({ "package.json": { scripts: { build: "tsc" } } });
    const { tasks } = await discoverTasks({ root });
    assert.equal(tasks[0]?.group, basename(root));
  });

  it("lists nothing for a directory without a project", async () => {
    const root = await writeTree({ "README.md": "hello" });
    assert.deepEqual((await discoverTasks({ root })).tasks, []);
  });

  it("survives a malformed package.json", async () => {
    const root = await writeTree({ "package.json": "{ nope" });
    assert.deepEqual((await discoverTasks({ root })).tasks, []);
  });

  for (const [lockfile, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    it(`runs through ${manager} when ${lockfile} is present`, async () => {
      const root = await writeTree({ "package.json": { scripts: { build: "tsc" } }, [lockfile]: "" });
      const task = byLabel((await discoverTasks({ root })).tasks, "build");
      assert.equal(task.command, manager);
      assert.equal(task.source, manager);
      assert.deepEqual(task.args, ["run", "build"]);
    });
  }

  it("prefers the packageManager field over a lockfile", async () => {
    const root = await writeTree({
      "package.json": { packageManager: "pnpm@11.0.0+sha512.abc", scripts: { build: "tsc" } },
      "yarn.lock": "",
    });
    assert.equal(byLabel((await discoverTasks({ root })).tasks, "build").command, "pnpm");
  });

  it("ignores a packageManager it does not know and falls back to the lockfile", async () => {
    const root = await writeTree({ "package.json": { packageManager: "deno@2", scripts: { build: "tsc" } }, "yarn.lock": "" });
    assert.equal(byLabel((await discoverTasks({ root })).tasks, "build").command, "yarn");
  });
});

describe("monorepos", () => {
  it("lists each pnpm workspace package as its own group, run in its own directory", async () => {
    const root = await writeTree({
      "package.json": { name: "mono", scripts: { lint: "eslint" } },
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/skipped'\n",
      "pnpm-lock.yaml": "",
      "packages/web/package.json": { name: "@acme/web", scripts: { build: "vite build" } },
      "packages/skipped/package.json": { name: "skipped", scripts: { build: "nope" } },
      "packages/not-a-package/README.md": "",
      "elsewhere/package.json": { name: "undeclared", scripts: { build: "nope" } },
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.label]), [["mono", "lint"], ["@acme/web", "build"]]);
    const web = byLabel(tasks, "build");
    assert.equal(web.cwd, join(root, "packages/web"));
    assert.equal(web.id, "task: @acme/web: build");
    assert.equal(web.command, "pnpm");
  });

  it("reads the workspaces field, as an array or as an object", async () => {
    for (const workspaces of [["apps/*"], { packages: ["apps/*"] }]) {
      const root = await writeTree({
        "package.json": { name: "mono", workspaces },
        "apps/api/package.json": { name: "api", scripts: { start: "node ." } },
      });
      assert.deepEqual((await discoverTasks({ root })).tasks.map((task) => task.group), ["api"]);
    }
  });

  it("expands ** without descending into node_modules", async () => {
    const root = await writeTree({
      "package.json": { name: "mono", workspaces: ["libs/**"] },
      "libs/a/b/package.json": { name: "deep", scripts: { build: "x" } },
      "libs/node_modules/dep/package.json": { name: "dep", scripts: { build: "x" } },
    });
    assert.deepEqual((await discoverTasks({ root })).tasks.map((task) => task.group), ["deep"]);
  });

  it("uses a literal workspace path and a glob inside a path segment", async () => {
    const root = await writeTree({
      "package.json": { name: "mono", workspaces: ["tools/cli", "pkg-*"] },
      "tools/cli/package.json": { name: "cli", scripts: { go: "x" } },
      "pkg-one/package.json": { name: "one", scripts: { go: "x" } },
      "other/package.json": { name: "other", scripts: { go: "x" } },
    });
    assert.deepEqual((await discoverTasks({ root })).tasks.map((task) => task.group).sort(), ["cli", "one"]);
  });

  it("takes a package's manager from the nearest lockfile, walking up to the root", async () => {
    const root = await writeTree({
      "package.json": { name: "mono", workspaces: ["a", "b"] },
      "bun.lock": "",
      "a/package.json": { name: "a", scripts: { go: "x" } },
      "a/yarn.lock": "",
      "b/package.json": { name: "b", scripts: { go: "x" } },
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.command]), [["a", "yarn"], ["b", "bun"]]);
  });

  it("orders the root group first and the other groups by name", async () => {
    const root = await writeTree({
      "package.json": { name: "zeta", workspaces: ["b", "a"], scripts: { go: "x" } },
      "a/package.json": { name: "alpha", scripts: { go: "x" } },
      "b/package.json": { name: "beta", scripts: { go: "x" } },
    });
    assert.deepEqual((await discoverTasks({ root })).tasks.map((task) => task.group), ["zeta", "alpha", "beta"]);
  });
});

describe("Makefile", () => {
  const makeTasks = async (files: Record<string, string | object>) => (await discoverTasks({ root: await writeTree(files) })).tasks;

  it("lists named rules and runs them with make in the Makefile's directory", async () => {
    const root = await writeTree({ Makefile: "build:\n\tgo build\n\ntest: build\n\tgo test\n" });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(labels(tasks), ["build", "test"]);
    assert.deepEqual({ ...byLabel(tasks, "test"), id: undefined }, {
      id: undefined,
      label: "test",
      group: tasks[0]?.group,
      source: "make",
      command: "make",
      args: ["test"],
      cwd: root,
      description: null,
      disabledReason: null,
    });
  });

  it("skips pattern, special and variable targets, assignments and recipes", async () => {
    const tasks = await makeTasks({
      Makefile: [
        "CC := gcc",
        "LIB ::= x",
        "NAME = a:b",
        "OPT ?= 1",
        "%.o: %.c",
        "\tgcc -c $<",
        ".DEFAULT_GOAL := all",
        ".SILENT:",
        "$(BIN): main.c",
        "\techo not: a-rule",
        "debug: CFLAGS = -g",
        "all: lib",
        "",
      ].join("\n"),
    });
    assert.deepEqual(labels(tasks), ["all"]);
  });

  it("skips targets that look like files unless they are .PHONY", async () => {
    const tasks = await makeTasks({
      Makefile: ".PHONY: docs.site out/clean\nfoo.txt:\n\ttouch foo.txt\nbuild/app:\n\tcc\ndocs.site:\n\tgen\nout/clean:\n\trm\n",
    });
    assert.deepEqual(labels(tasks).sort(), ["docs.site", "out/clean"]);
  });

  it("honours a .PHONY declared after the rule and in an included file", async () => {
    const tasks = await makeTasks({ Makefile: "include phony.mk\nrelease.all:\n\tgo\n", "phony.mk": ".PHONY: release.all\n" });
    assert.deepEqual(labels(tasks), ["release.all"]);
  });

  it("uses a ## comment as the description, inline or on the line above", async () => {
    const tasks = await makeTasks({ Makefile: "build: ## Compile it\n\tcc\n\n## Run the checks\ntest:\n\tcc\n\n# plain comment\nlint:\n\tcc\n" });
    assert.equal(byLabel(tasks, "build").description, "Compile it");
    assert.equal(byLabel(tasks, "test").description, "Run the checks");
    assert.equal(byLabel(tasks, "lint").description, null);
  });

  it("follows literal includes, ignores variable ones and survives a cycle", async () => {
    const tasks = await makeTasks({
      Makefile: "include common.mk\n-include missing.mk\ninclude $(SHELL_INCLUDE)\nroot:\n\tcc\n",
      "common.mk": "include Makefile\nshared:\n\tcc\n",
    });
    assert.deepEqual(labels(tasks).sort(), ["root", "shared"]);
  });

  it("does not follow an include outside the workspace", async () => {
    const outside = await writeTree({ "evil.mk": "outside:\n\tcc\n" });
    const tasks = await makeTasks({ Makefile: `include ${join(outside, "evil.mk")}\nroot:\n\tcc\n` });
    assert.deepEqual(labels(tasks), ["root"]);
  });

  it("does not take text inside define blocks for rules and joins continued lines", async () => {
    const tasks = await makeTasks({ Makefile: "define BLOCK\nnot-a-rule:\n\tcc\nendef\none \\\ntwo: dep\n\tcc\n" });
    assert.deepEqual(labels(tasks), ["one", "two"]);
  });

  it("does not take words inside a make function on a rule line for targets", async () => {
    const tasks = await makeTasks({ Makefile: "$(warning Deprecated: use x)\n$(addprefix gen-, a b):\n\tcc\nreal:\n\tcc\n" });
    assert.deepEqual(labels(tasks), ["real"]);
  });

  it("skips indented assignments inside conditionals", async () => {
    const tasks = await makeTasks({ Makefile: "ifeq ($(OS),Linux)\n  CC := gcc\n  URL = http://x\nendif\nreal:\n\tcc\n" });
    assert.deepEqual(labels(tasks), ["real"]);
  });

  it("deduplicates a double-colon rule declared twice", async () => {
    const tasks = await makeTasks({ Makefile: "clean::\n\trm a\nclean::\n\trm b\n" });
    assert.deepEqual(labels(tasks), ["clean"]);
  });

  it("looks in each declared package and joins the package's group", async () => {
    const root = await writeTree({
      "package.json": { name: "mono", workspaces: ["svc"] },
      "svc/package.json": { name: "svc", scripts: { start: "x" } },
      "svc/makefile": "image:\n\tdocker build\n",
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.label, task.source]), [["svc", "start", "npm"], ["svc", "image", "make"]]);
    assert.equal(byLabel(tasks, "image").cwd, join(root, "svc"));
  });

  it("keeps the root group first across sources and tells same-named tasks apart", async () => {
    const root = await writeTree({
      "package.json": { name: "zeta", workspaces: ["pkg"], scripts: { build: "x" } },
      "pkg/package.json": { name: "alpha", scripts: { go: "x" } },
      Makefile: "build:\n\tcc\n",
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.label]), [["zeta", "build"], ["zeta", "build (make)"], ["alpha", "go"]]);
    assert.deepEqual(tasks.map((task) => task.id), ["task: build", "task: build (make)", "task: alpha: go"]);
  });

  it("keeps three same-named tasks apart", async () => {
    const root = await writeTree({
      ".vscode/tasks.json": { tasks: [{ label: "x", command: "a" }, { label: "x", command: "b" }, { label: "x", command: "c" }] },
    });
    assert.deepEqual(labels((await discoverTasks({ root })).tasks), ["x", "x (vscode)", "x (vscode 2)"]);
  });
});

describe(".vscode/tasks.json", () => {
  const vscode = (tasks: object[]) => ({ ".vscode/tasks.json": `// settings\n${JSON.stringify({ version: "2.0.0", tasks }).replace(/}$/, ",}")}` });

  it("lists tasks from a file with comments and trailing commas, in the root group", async () => {
    const root = await writeTree({ "package.json": { name: "app" }, ...vscode([{ label: "Serve", command: "python -m http.server", args: ["8000", "--bind", "a b"] }]) });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks, [
      {
        id: "task: Serve",
        label: "Serve",
        group: "app",
        source: "vscode",
        command: "python -m http.server",
        args: ["8000", "--bind", "a b"],
        cwd: root,
        description: null,
        disabledReason: null,
      },
    ]);
  });

  it("substitutes ${workspaceFolder} and resolves options.cwd against the root", async () => {
    const root = await writeTree(vscode([
      { label: "a", command: "${workspaceFolder}/run.sh", args: ["${workspaceFolder}/x"], options: { cwd: "${workspaceFolder}/sub" } },
      { label: "b", command: "ls", options: { cwd: "rel/dir" } },
    ]));
    const { tasks } = await discoverTasks({ root });
    assert.equal(byLabel(tasks, "a").command, `${root}/run.sh`);
    assert.deepEqual(byLabel(tasks, "a").args, [`${root}/x`]);
    assert.equal(byLabel(tasks, "a").cwd, join(root, "sub"));
    assert.equal(byLabel(tasks, "b").cwd, join(root, "rel/dir"));
  });

  it("reads a quoted argument object by its value", async () => {
    const root = await writeTree(vscode([{ label: "a", command: { value: "echo", quoting: "strong" }, args: [{ value: "hi there", quoting: "strong" }] }]));
    const task = byLabel((await discoverTasks({ root })).tasks, "a");
    assert.equal(task.command, "echo");
    assert.deepEqual(task.args, ["hi there"]);
  });

  it("lists tasks needing ${input:...} or another VS Code variable as disabled", async () => {
    const root = await writeTree(vscode([
      { label: "prompt", command: "deploy", args: ["${input:env}"] },
      { label: "file", command: "cat ${file}" },
    ]));
    const { tasks } = await discoverTasks({ root });
    assert.match(byLabel(tasks, "prompt").disabledReason ?? "", /input/i);
    assert.match(byLabel(tasks, "file").disabledReason ?? "", /\$\{file\}/);
  });

  it("lists a task without a command as disabled and skips one without a label", async () => {
    const root = await writeTree(vscode([{ label: "compound", dependsOn: ["a", "b"] }, { type: "npm", script: "build" }]));
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(labels(tasks), ["compound"]);
    assert.ok(tasks[0]?.disabledReason);
  });

  it("leaves comment and comma lookalikes inside strings alone and skips block comments", async () => {
    const root = await writeTree({
      ".vscode/tasks.json": `{ /* block */ "tasks": [ { "label": "a,]", "command": "echo // not a comment /* nor this */ \\"q\\"", }, /* end */ ], }`,
    });
    const [task] = (await discoverTasks({ root })).tasks;
    assert.equal(task?.label, "a,]");
    assert.equal(task?.command, `echo // not a comment /* nor this */ "q"`);
  });

  it("lists nothing for a malformed file", async () => {
    const root = await writeTree({ ".vscode/tasks.json": "{{{" });
    assert.deepEqual((await discoverTasks({ root })).tasks, []);
  });
});

describe("nx from files", () => {
  const nxRoot = { "nx.json": {}, "package.json": { name: "mono", scripts: { format: "prettier" } }, "pnpm-lock.yaml": "" };

  it("lists project.json targets through nx run, in the project's directory", async () => {
    const root = await writeTree({ ...nxRoot, "apps/web/project.json": { name: "web", targets: { build: {}, serve: {} } } });
    const { tasks, nx } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.label]), [["mono", "format"], ["web", "build"], ["web", "serve"]]);
    assert.deepEqual({ ...byLabel(tasks, "build"), id: "" }, {
      id: "",
      label: "build",
      group: "web",
      source: "nx",
      command: "pnpm",
      args: ["exec", "nx", "run", "web:build"],
      cwd: join(root, "apps/web"),
      description: null,
      disabledReason: null,
    });
    assert.deepEqual(nx, { inferred: "off", failure: null });
  });

  it("is not an Nx workspace without nx.json", async () => {
    const root = await writeTree({ "package.json": { name: "a" }, "apps/web/project.json": { name: "web", targets: { build: {} } } });
    const { tasks, nx } = await discoverTasks({ root });
    assert.deepEqual(tasks, []);
    assert.equal(nx, null);
  });

  it("merges a project's scripts with its targets by name and keeps the rest", async () => {
    const root = await writeTree({
      ...nxRoot,
      "package.json": { name: "mono", workspaces: ["apps/*"] },
      "apps/web/project.json": { name: "web", targets: { build: {} } },
      "apps/web/package.json": { name: "@acme/web", scripts: { build: "vite build", preview: "vite preview" } },
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.label, task.source]), [["web", "preview", "pnpm"], ["web", "build", "nx"]]);
  });

  it("reads targets from a package.json nx field", async () => {
    const root = await writeTree({
      ...nxRoot,
      "package.json": { name: "mono", workspaces: ["libs/*"] },
      "libs/ui/package.json": { name: "ui", nx: { targets: { storybook: {} } } },
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.map((task) => [task.group, task.source, task.args.at(-1)]), [["ui", "nx", "ui:storybook"]]);
  });

  it("falls back to the directory for a project without a name and skips node_modules", async () => {
    const root = await writeTree({
      ...nxRoot,
      "libs/data/project.json": { targets: { test: {} } },
      "node_modules/dep/project.json": { name: "dep", targets: { build: {} } },
    });
    const { tasks } = await discoverTasks({ root });
    assert.deepEqual(tasks.filter((task) => task.source === "nx").map((task) => task.args.at(-1)), ["data:test"]);
  });
});

describe("nx inferred targets", () => {
  /** A stand-in for the repo's local nx, which is all discovery may execute. */
  const fakeNx = (body: string) => ({ "node_modules/.bin/nx": `#!/bin/sh\n${body}\n` });
  const writeGraph = (nodes: object) =>
    `for arg in "$@"; do case "$arg" in --file=*) printf '%s' '${JSON.stringify({ graph: { nodes } })}' > "\${arg#--file=}";; esac; done`;
  const nodes = {
    web: { name: "web", type: "app", data: { root: "apps/web", targets: { build: {}, "build-storybook": {} } } },
  };
  const makeExecutable = async (root: string) => chmod(join(root, "node_modules/.bin/nx"), 0o755);
  const nxRoot = { "nx.json": {}, "pnpm-lock.yaml": "" };

  it("runs nothing unless inferred targets were asked for", async () => {
    const marker = join(await writeTree({}), "ran");
    const root = await writeTree({ ...nxRoot, "package.json": { name: "mono" }, ...fakeNx(`touch ${marker}`) });
    await makeExecutable(root);
    await discoverTasks({ root });
    await assert.rejects(access(marker));
  });

  it("shows each project once through nx run and keeps root scripts no project owns", async () => {
    const root = await writeTree({
      ...nxRoot,
      "package.json": { name: "mono", workspaces: ["apps/*"], scripts: { format: "prettier" } },
      "apps/web/package.json": { name: "web", scripts: { build: "vite build", preview: "vite preview" } },
      ...fakeNx(writeGraph(nodes)),
    });
    await makeExecutable(root);
    const { tasks, nx } = await discoverTasks({ root, inferred: new InferredTargets() });
    assert.deepEqual(tasks.map((task) => [task.group, task.label, task.source]), [
      ["mono", "format", "pnpm"],
      ["web", "build", "nx"],
      ["web", "build-storybook", "nx"],
    ]);
    assert.deepEqual(nx, { inferred: "on", failure: null });
  });

  it("treats root scripts as owned when the root is itself a project", async () => {
    const root = await writeTree({
      ...nxRoot,
      "package.json": { name: "mono", scripts: { format: "prettier" } },
      ...fakeNx(writeGraph({ mono: { name: "mono", type: "app", data: { root: ".", targets: { lint: {} } } } })),
    });
    await makeExecutable(root);
    const { tasks } = await discoverTasks({ root, inferred: new InferredTargets() });
    assert.deepEqual(tasks.map((task) => [task.label, task.source]), [["lint", "nx"]]);
  });

  it("falls back to the files with the reason when nx is missing", async () => {
    const root = await writeTree({ ...nxRoot, "package.json": { name: "mono" }, "apps/web/project.json": { name: "web", targets: { build: {} } } });
    const { tasks, nx } = await discoverTasks({ root, inferred: new InferredTargets() });
    assert.deepEqual(labels(tasks), ["build"]);
    assert.equal(nx?.inferred, "failed");
    assert.match(nx?.failure ?? "", /node_modules/);
  });

  it("falls back to the files when nx exits non-zero", async () => {
    const root = await writeTree({ ...nxRoot, "package.json": { name: "mono" }, "apps/web/project.json": { name: "web", targets: { build: {} } }, ...fakeNx("echo boom >&2; exit 1") });
    await makeExecutable(root);
    const { tasks, nx } = await discoverTasks({ root, inferred: new InferredTargets() });
    assert.deepEqual(labels(tasks), ["build"]);
    assert.equal(nx?.inferred, "failed");
    assert.match(nx?.failure ?? "", /boom/);
  });

  it("answers with the files while a slow nx runs, then picks the result up", async () => {
    const root = await writeTree({
      ...nxRoot,
      "package.json": { name: "mono" },
      "apps/web/project.json": { name: "web", targets: { build: {} } },
      ...fakeNx(`sleep 0.4\n${writeGraph(nodes)}`),
    });
    await makeExecutable(root);
    const inferred = new InferredTargets({ waitMs: 20 });
    const first = await discoverTasks({ root, inferred });
    assert.equal(first.nx?.inferred, "loading");
    assert.deepEqual(labels(first.tasks), ["build"]);
    await delay(700);
    const second = await discoverTasks({ root, inferred });
    assert.equal(second.nx?.inferred, "on");
    assert.deepEqual(labels(second.tasks), ["build", "build-storybook"]);
  });

  it("never runs nx outside an Nx workspace, even when asked", async () => {
    const marker = join(await writeTree({}), "ran");
    const root = await writeTree({ "package.json": { name: "a" }, ...fakeNx(`touch ${marker}`) });
    await makeExecutable(root);
    const { nx } = await discoverTasks({ root, inferred: new InferredTargets() });
    assert.equal(nx, null);
    await assert.rejects(access(marker));
  });
});
