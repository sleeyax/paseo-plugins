# Tasks run in terminals the plugin owns

Each task runs in a workspace terminal the plugin creates through the SDK, named `task: <label>`, rather than through a `scripts` entry in `paseo.json`.
Listing and running tasks therefore never modifies the repository.
The terminal's name is the only link between a task and its run, so status survives app reloads with no stored state.
Port handling is the cost: plugins cannot reach Paseo's allocator and `terminals.create` has no `env` option, so tasks rely on the project's own port config.
