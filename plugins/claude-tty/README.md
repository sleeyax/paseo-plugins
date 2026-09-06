# Claude TTY

Install, diagnose, and manage the [Claude TTY ACP adapter](../../apps/claude-tty-acp) on the host running the Paseo daemon.

The adapter's own setup is a checklist a person follows on each host: build it, check it, add a provider entry, reload the daemon. This plugin does that from Paseo's sidebar instead, on whichever host is selected.

## Screenshots

_None yet._

## Installation

```sh
paseo plugin install "/absolute/path/to/paseo-plugins/plugins/claude-tty"
```

Unlike the other plugins here, this one is installed from a clone rather than from Git. A Git installation runs no package manager, and this plugin manages an adapter that has to be built, so install it from the same clone that holds `apps/claude-tty-acp` and build the adapter there first:

```sh
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
```

Then open **Claude TTY** in the Paseo sidebar and press **Install**.

That checks the adapter is built, runs its host checks, registers the `traecli` provider, and asks Paseo to re-probe its providers. No daemon restart is needed. The adapter README explains [why the provider ID is borrowed](../../apps/claude-tty-acp/README.md#slash-commands-need-a-borrowed-provider-id).

Two things stay yours to arrange, because the plugin cannot do them for you:

- **A built adapter.** The plugin never builds one: it reports whether `apps/claude-tty-acp/dist/cli.js` exists and refuses to register a provider pointing at an executable that would not start. Rebuild it by hand after pulling, then press **Install** again.
- **An authenticated Claude.** Run `claude` interactively as the user the daemon runs as. The plugin never touches Claude's configuration, credentials, or transcripts.

Everything is host-local: selecting another host in Paseo shows that host's own answer, and each host is installed separately.

## Settings

The **Suspend idle Claude** setting controls how long a native Claude process remains alive after the session last did anything. It defaults to one hour, and you can choose 15 minutes through 8 hours, or **Never**.

Suspending stops the PTY and any background tasks it owns, but does not close or archive the Paseo agent. The adapter keeps the persisted session mapping, and the next prompt automatically launches `claude --resume` with the same Claude session, model, and mode. The timer runs from the last thing the session actually did, not from the last prompt: a turn Claude runs on its own after a task notification, the agents it launches, and the hooks it calls all count, so a session working unattended is not stopped mid-run.

A session waiting on a subagent is not suspended at all. The adapter holds the turn open until every agent it launched has reported, which is also what makes Paseo show the session as busy while they work, and a suspension stands aside for an active turn and tries again later. A turn whose agents have written nothing for fifteen minutes stops waiting, so a stuck agent cannot keep a session alive indefinitely. Background commands are not agents and hold nothing open.

The adapter reads the setting each time it schedules a suspension, so a change applies to sessions that are already open rather than only to the next adapter launch. A suspension also stands aside while a permission or question card is still waiting for an answer, and tries again later.

Setting `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` on the provider entry, or on the daemon itself, overrides this setting for the hosts that do it; the panel says so when the entry is what sets it.

An entry pointing at a different checkout is reported as a mismatch and left alone until you press **Point it at this checkout**, and an entry the plugin does not recognise is never written over at all.

## Troubleshooting

**Diagnostics** runs the host checks of the executable the daemon would actually launch — not the one this checkout builds — and shows Paseo's own provider diagnostic beneath them. A stale entry pointing somewhere else is exactly what that distinction catches.

**Sessions** lists the adapter's saved sessions and the locks over them, each named after the Paseo agent holding it and saying when it was last prompted. That reads "last prompted" rather than "active" on purpose: the adapter stamps the time as a prompt starts, so a session an hour into one turn is still working.

**Subagents** lists the subagents of every open session — what each was asked to do, whether it is running, and when it last did anything — and opens one to show the steps it has taken: how far into the run each happened, what it said, the command or path each tool call was handed, and the reason any of them failed. Only open sessions are listed, because a subagent runs inside its session's Claude process and stops with it. A subagent whose launch has since been compacted out of the session's transcript is still listed, named after the opening line of its prompt.

The same work also streams into the tool call that launched it, in the conversation itself, which is where to watch one as it runs. It cannot be opened as a tab of its own: a subagent is not an ACP session or a Paseo agent but a loop inside the one Claude process, so there is nothing for Paseo to attach a tab to, and a plugin can only open a surface it contributes itself.

**Stop** ends the adapter process holding an open session, which closes its Claude terminal. Nothing durable goes with it: the session file, the transcript, and the Paseo agent all survive, and the next prompt resumes the same Claude session.

A PID outlives the process that earned it, so a stop first establishes that the process really is the one that took the lock — the right kind of process, and one that cannot have started after the lock it holds. Anything else is refused, named, and left running, including a process that has already exited and is waiting to be reaped. The adapter is given ten seconds to close the session itself before it is forced.

A lock names the process holding a session; the adapter clears its own on exit and recovers one left by a dead process, so **Release lock** is only for a lock that outlived its process and is still in the way — including one left behind by a stop that had to force the process. Releasing is refused while the recorded process is alive. A session file that cannot be read can be moved aside rather than deleted, so the failure is still there to diagnose.

The adapter's [troubleshooting table](../../apps/claude-tty-acp/README.md#troubleshooting) covers everything that goes wrong once a session is running.

The **Danger zone** removes the provider entry and nothing else. Deleting the state directory is a separate opt-in, refused while a session is open, and the source checkout is never touched.

## Development

```sh
paseo plugin reload claude-tty
paseo plugin logs claude-tty
```

```sh
pnpm --filter @paseo-plugins/claude-tty typecheck
pnpm --filter @paseo-plugins/claude-tty test
```

See [CLAUDE.md](./CLAUDE.md) for the constraints that are not obvious from the code.
