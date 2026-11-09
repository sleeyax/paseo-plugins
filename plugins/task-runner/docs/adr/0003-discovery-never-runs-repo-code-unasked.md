# Discovery never runs repo code unasked

Opening a panel on an untrusted checkout must not execute anything from it, so every source reads files as text.
Makefiles are parsed statically because `make -pn` expands `$(shell ...)`, which means some generated targets are missed.
Nx targets come from `project.json` and `package.json`, which misses targets inferred by Nx plugins, because only the Nx CLI knows those and it executes plugin code from the repository.
The **Load inferred targets** button runs the repository's own `nx` only after the user asks, and the choice is remembered per workspace.
