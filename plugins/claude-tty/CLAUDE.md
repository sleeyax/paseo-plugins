# Working on this plugin

Run `paseo plugin reload claude-tty` after every change, then `paseo plugin logs claude-tty`.
The reload is the only compile check of the two bundles the daemon builds.
Do this yourself; never leave it to the user.
That log is the plugin's; the adapter's is `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`, because the daemon drops the adapter's stderr, and a running adapter process keeps the code it started with — a rebuilt `dist/` reaches the sessions started after it.

`paseo plugin install <directory>` works against a 0.6 daemon and writes the `plugins` entry itself, but the plugin only loads once `pluginsEnabled` is true in `~/.paseo/config.json` and `paseo reload` has run.
The v0.7 `paseo plugin add <repo>` form is not usable for this plugin: a Git installation runs no package manager, and the adapter this plugin manages has to be built.

To exercise a handler without a client, invoke it over the daemon's own plugin RPC:

```js
import { connectToDaemon } from "/usr/lib/node_modules/@getpaseo/cli/dist/utils/client.js";
const client = await connectToDaemon({});
console.log(await client.invokePluginRpc("claude-tty", "claude-tty.status", {}));
```

That is the only way to see what a step machine or a filesystem guard actually does, so use it rather than reasoning about the code.

## The checkout is not discoverable

The plugin manages the adapter in the checkout it was installed from, and a bundled plugin has no path of its own to walk up from.
`paseo.config.get().plugins["claude-tty"].path` is the one source, and `apps/claude-tty-acp/package.json` has to exist two levels above it before anything else is worth reporting.

## Constraints that are not obvious

The daemon's `PATH` is not your shell's.
A systemd daemon typically has `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` and nothing else, so Claude is routinely missing from it.
That is a reading the surface reports, not an error to hide, and every spawn failure has to read as a sentence rather than a stack trace.

The plugin never builds the adapter, because a daemon that cannot see a package manager cannot be made to.
It reports whether `dist/cli.js` is there and leaves the build to whoever owns the checkout.

A plugin session cannot see a custom provider in `providers.snapshot()`.
The daemon filters every entry through `isProviderVisibleToClient`, which falls back to `claude`, `codex` and `opencode` for any session that does not declare an `appVersion`, so the doctor reads `providers.diagnostic` instead, which is not filtered.

`config.patch` applies to the live provider registry without a daemon restart, because `agents.providers` is reloadable and the daemon stages the change into the registry as it persists it.
`deepMerge` replaces arrays wholesale but keeps keys the patch does not mention, so repointing an entry has to `removeProviders` first and re-add, or a stale `env` or `models` survives the rewrite.
The daemon validates a custom provider on its way in: the ID must match `^[a-z][a-z0-9-]*$`, `extends` must be a builtin or `acp`, and `extends: "acp"` requires a non-empty `command`.

The installer's job outlives the request that starts it, so it lives in module scope and the client polls it.
Module scope is the only state a plugin process has between RPC calls.

Session and lock liveness is decided with signal 0 exactly the way the adapter decides it, so the two never disagree about which lock is stale.

Stopping a session signals the process the lock names, which is one adapter process per ACP session, spawned by the daemon.
`SIGTERM` is enough: the adapter's own handler closes the session, which stops the Claude PTY and releases the lock, so the persisted session and the Paseo agent both survive and the next prompt resumes them.
Never signal a process group: the daemon spawns the adapter undetached, so `-pid` is the daemon's own group.

## Identifying the process a lock names

Signal 0 proves only that a PID is taken, and a PID outlives the process that earned it, so `ownsLock` has to establish who is actually behind it.

The command line alone cannot do it.
Matching the adapter's name and its entry file as free-floating substrings passes for the `claude` child — it is handed a `--settings` path carrying the adapter's name, and is itself `node <...>/cli.js` wherever Claude Code is installed as a bundle rather than as a binary — and for any bystander whose arguments merely mention the checkout.
So the command has to match as one path, `<...>/claude-tty-acp/<...>/cli.js`, and even then it says only what kind of process this is, never *which*: a second adapter that inherited the PID looks exactly like the first.
That pattern is built from the same names `paths.shared.ts` registers the adapter under, so renaming either cannot leave a guard matching the old one behind.
It lives in `lock-owner.shared.ts` rather than beside the session join, because `sessions.shared.ts` is bundled into the client and `paths.shared.ts` reaches for `node:os` and `node:path`.

The start time is the half that settles it.
Two live processes cannot share a PID, so a process that was already running when the lock was written and still holds that PID is the process that wrote it.
`/proc/<pid>/stat` field 22 against `/proc/uptime` gives it, `ps -o lstart=` gives it elsewhere, and both need slack — `ps` truncates to the second and a boot-time reading drifts against the wall clock, while PIDs take far longer than seconds to come round again.
`/proc` also reports the zombie state, which is worth its own sentence to the user: a process waiting to be reaped cannot be stopped and has not been left running.

Identity is proved again before the `SIGKILL` escalation, because the adapter may have exited during the wait and something else may hold the PID by then.
Concurrent stops of one session are coalesced onto a single promise: the adapter registers its handler with `process.once`, so a second `SIGTERM` arriving mid-shutdown takes the default action and kills it before it can release its lock.

## Agent titles are a courtesy and are budgeted like one

A session row is named after the Paseo agent holding it, joined on the ACP session ID: the daemon stores it as an agent's `runtimeInfo.sessionId` and `persistence.sessionId`, and it is this plugin's file stem.
`paseo.agents.list()` answers with the daemon's `{ agent, project }` entries, and the SDK types say so: its `entries` are `FetchAgentsEntry`, which is that wrapper and not the agent itself.
A bare agent is read as well, but only as tolerance for a shape the SDK has never handed over — not because the types and the wire disagree.

The lookup never gates a decision.
Mutations read the state directory through `readState`, which does not touch the daemon; only the payload handed back is decorated.
It is also raced against a budget and paged explicitly, because the SDK waits a minute by default while the daemon kills a plugin RPC at 30 seconds, and one page is capped at 200 agents.
A daemon that stalls or pages forever costs the titles and nothing else, which is the whole claim.

## There is no way to open an agent from here

`openSurface` and `openPanel` live on command contexts and on the client-side entry point, never on a surface's props, and the only `openPanel` target is a panel this plugin contributes.
Paseo has a `{ kind: "agent" }` navigation target of its own but does not expose it, so nothing a plugin can call reveals an agent's terminal.
An "open" button built on `addClientSide` and an agent panel was tried and removed: the closest the API reaches is opening a tab that shows the same row the sidebar already shows, which is worse than sending someone to the agent list.

## A subagent is not a session, and its work is in another file

Claude writes a subagent's turns to `<projects>/<claude session id>/subagents/agent-<agent id>.jsonl`, never into the session's own transcript, which carries only the launch and — for an asynchronous agent — a `<task-notification>` in a later user turn saying it stopped.
So both files are read: the session's for the launch metadata Claude leaves beside the tool result (`toolUseResult.agentId`, and `status: "async_launched"` for one that has only started), and the subagent's for anything it actually did.
Claude also writes an `agent-<agent id>.meta.json` beside each transcript carrying the description, the tool use that launched it and its `spawnDepth`, which is the only thing that names a subagent another subagent launched, because the session's transcript never sees one.
An asynchronous launch answers its launcher immediately, so a tool result is not proof the agent finished; the notification is.
Claude writes that notification into the turn it wakes for after the agent reports, so a session whose process stops first never writes one:
a launch left open in a finished transcript says only that nobody was there to hear the end of it, never that the agent is still working.

The panel lists only open sessions, because a subagent is a loop inside its session's Claude process and stops with it, and it is not an ACP session or a Paseo agent, so the paragraph above about opening an agent applies to it twice over.
An asynchronous launch with no notification after it reads as running in the panel, and nothing on disk says whether the Claude process behind it is still the one that launched it.
So an agent launched before a suspension or a model change stays listed as running until its session closes, with the last-step label as the only sign, while the adapter closes its card in the conversation because it knows the process stopped.
Both files are read incrementally from module scope, the way the adapter reads them, because each runs to megabytes and the panel polls: what is new is parsed onto what was already read, a rewrite is noticed by comparing the head of the file rather than its length, and only the tail of steps the panel shows is kept.
Module scope lives as long as the plugin process, so everything it holds is keyed by the session directory it was read for and dropped as soon as that session is no longer open.

## index.ts is AST-filtered

The daemon builds both bundles from the entry, deleting `plugin.handle(...)` and `*.server` imports for the client, and `plugin.add*` and `*.client` imports for the server.
The deletion is textual, so only mention a server module inside `plugin.handle(...)` and a client module inside `plugin.add*`.
The entry must default-export one function taking one named parameter with a block body, and RPC names must match `^[a-z][a-z0-9._-]*$`.

## The panel is styled off paseo's own scale

`src/client/theme.client.ts` and `src/client/ui.client.tsx` are copies of the Discord plugin's, because the host hands plugins no metrics and each plugin directory has to bundle from its own root.
Build new controls out of those tokens rather than out of literals, and keep the two files in step with their originals.
Icons come from `@getpaseo/plugin/react-native`, by Lucide name; nothing here draws its own.

## Tests

`pnpm test` is `node --test "src/**/*.test.ts"` through Node's type stripping, so no TypeScript that has to be emitted and relative imports keep their `.ts` extension.
Tests must not import `contracts.shared.ts`, because `@getpaseo/plugin/server` only exists inside the daemon — keep the decisions in modules the tests can reach.
`@getpaseo/client` is on 0.7.0 across the workspace; this plugin needs at least 0.6, because `paseo.config` and `paseo.providers` do not exist before that.
