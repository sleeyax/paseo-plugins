# Task Runner

Run the scripts your project already defines from a **Tasks** panel in the Explorer, without declaring them again in `paseo.json`.
It lists `package.json` scripts, Makefile targets, Nx targets and `.vscode/tasks.json` tasks.

## Installation

Requires:

- Paseo 0.15 or newer
- A macOS or Linux host

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/task-runner
```

Update with `paseo plugin update task-runner`.
To install from source, see the [root README](../../README.md#from-source).

## Usage

### Open the panel

Open **Tasks** in the Explorer, or choose **Run Task...** in the Command Center.
The list is scanned when the panel opens and when you select refresh.

In a monorepo, each package from `pnpm-workspace.yaml` or the `workspaces` field is its own group, and so is each Nx project.

### Run a task

Select the play button on a row.
The task runs in its package's directory, in its own workspace terminal named `task: <label>`, or `task: <package>: <label>` in a monorepo.
That terminal opens as a tab without taking focus.
Running a finished task again replaces its terminal.

Scripts run through the package manager from the `packageManager` field, then the nearest lockfile, then npm.

Select a row with output to see its last 50 lines.

### Stop a task

Select **Stop** on a running row to send the task Ctrl+C.
If the task ignores it, select **Force kill** to close its terminal.

### See Nx's inferred targets

Nx targets are read from `project.json` and `package.json`.
To also list the targets Nx plugins infer, select **Load inferred targets**, which runs the repository's own `nx`.
The choice is remembered per workspace, and **Use files only** turns it off.

### Use `.vscode/tasks.json` for anything else

Tasks are read from the `label`, `command`, `args` and `options.cwd` fields, and only `${workspaceFolder}` is filled in.

## Development

For development instructions, see the [root README](../../README.md#development).

Design decisions are in [docs/adr](docs/adr).
