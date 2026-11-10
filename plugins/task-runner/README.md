# Task Runner

Run the scripts your project already defines from a **Tasks** panel in the Explorer, without declaring them again in `paseo.json`.

## Installation

Requires:

- Paseo 0.15 or newer
- A macOS or Linux host

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/task-runner
```

Update with `paseo plugin update task-runner`.
To install from source, see the [root README](../../README.md#from-source).

## Features

- Lists `package.json` scripts, Makefile targets, Nx targets and `.vscode/tasks.json` tasks.
- Runs scripts with the project's own package manager: npm, pnpm, yarn or bun.
- Groups tasks by package in workspaces and Nx monorepos.
- Runs each task in its own terminal, with its status and recent output in the panel.
- Stops, restarts and force kills running tasks.
- Opens from **Run Task...** in the Command Center.
- Lists tasks without running your repository's code, and loads targets inferred by Nx plugins only when you ask.

## Development

For development instructions, see the [root README](../../README.md#development).

Design decisions are in [docs/adr](docs/adr).
