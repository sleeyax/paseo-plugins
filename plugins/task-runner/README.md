# Task Runner

Run the scripts your project already defines from a **Tasks** panel in the Explorer, without declaring them again in `paseo.json`.
It lists `package.json` scripts, Makefile targets, Nx targets and `.vscode/tasks.json` tasks.

## Installation

Requires:

- Paseo 0.15 or newer
- `pnpm` on the daemon's `PATH`
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

### Run a task

Select the play button on a row.
The task runs in its own workspace terminal named `task: <label>`, and that terminal opens as a tab without taking focus.
Running a finished task again replaces its terminal.

Select a row with output to see its last 50 lines.

### Stop a task

A running row has **Stop** and **Restart**.
**Stop** sends Ctrl+C and keeps the output.
If the task is still running about 5 seconds later, the row offers **Force kill**, which closes its terminal.

### Work in a monorepo

Each package from `pnpm-workspace.yaml` or the `workspaces` field is a collapsible group, and its tasks run in that package's directory.
Each Nx project is a group too.

Commands use the package manager from the `packageManager` field, then the nearest lockfile, then npm.

### See Nx's inferred targets

Listing tasks never runs code from your repository, so Nx targets are read from `project.json` and `package.json`.
Targets inferred by Nx plugins are only known to Nx itself.
Select **Load inferred targets** to run the repository's own `nx`.
The choice is remembered per workspace, and **Use files only** turns it off.

### Use `.vscode/tasks.json` for anything else

Tasks are read from the `label`, `command`, `args` and `options.cwd` fields, and `${workspaceFolder}` is filled in.
Tasks that need another VS Code variable, such as `${input:...}`, are listed but disabled.

## Development

For development instructions, see the [root README](../../README.md#development).

Design decisions are in [docs/adr](docs/adr).
