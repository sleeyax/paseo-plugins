# Claude TTY ACP

Run the genuine interactive Claude Code CLI as a native Paseo agent.

Paseo speaks [ACP](https://agentclientprotocol.com) to this adapter, and the adapter keeps a single real `claude` process in a PTY per session.
It translates that process's transcripts and hooks into native Paseo messages, reasoning, tool calls, plans, permissions, models, modes, slash commands, attachments, cancellation, and history.
There is no `claude -p` and no Claude Agent SDK anywhere in the path.

## Why?

Paseo's built-in Claude agent runs on the Claude Agent SDK.
Agent SDK integrations appear to consume usage limits faster than the Claude Code CLI or its editor extensions, [as reported for t3code and similar tools](https://github.com/pingdotgg/t3code/issues/7338#issuecomment-5426425282); whether the cause is the SDK, its integrations, or Anthropic's backend is unclear.

This adapter avoids the SDK by driving the same CLI you would otherwise run in a terminal.
You keep its binary, authentication, billing, sessions, `CLAUDE.md` hierarchy, MCP servers, plugins, skills, and permission rules, and get Paseo's native agent UI on top of them.
The price is that every native affordance has to be reconstructed from terminal output, transcript files, and hooks, which is where the [limitations](#limitations) come from.

## Requirements

- Linux or macOS
- Node.js 22 or newer
- pnpm
- A current Claude Code CLI, authenticated on the same host as the Paseo daemon
- A Paseo version that supports custom ACP providers

## Installation

Setup is host-local: the adapter runs wherever the Paseo daemon runs, so repeat every step below on each host that should offer Claude.
See [Multiple hosts](#multiple-hosts) for what that means in practice.

The [Claude Code plugin](../../plugins/claude-tty) does all of this from Paseo's sidebar, on whichever host is selected, and manages the provider entry afterwards.
Install it instead if you would rather not run the steps below by hand; you still have to authenticate Claude yourself, as in [step 2](#2-authenticate-claude).

### 1. Build the adapter

```sh
git clone https://github.com/sleeyax/paseo-plugins.git /opt/paseo-plugins
cd /opt/paseo-plugins
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp --diagnose
```

### 2. Authenticate Claude

Run `claude` interactively as the same OS user that runs the Paseo daemon, and complete authentication before using the provider.
If the daemon runs through systemd, SSH into that account or use an equivalent login shell so Claude writes its credentials into the correct home directory.

### 3. Register the provider

Add the provider to that host's Paseo configuration:

```json
{
  "agents": {
    "providers": {
      "traecli": {
        "extends": "acp",
        "label": "Claude Code (interactive)",
        "command": [
          "/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp"
        ],
        "params": {
          "supportsMcpServers": false
        }
      }
    }
  }
}
```

Restart or reload the Paseo daemon afterwards.

A few details in that snippet are deliberate:

- `supportsMcpServers: false` refers only to MCP servers that Paseo injects over ACP, which a running interactive Claude process cannot adopt.
  Claude's own MCP servers are unaffected; it loads them from its usual configuration at startup.
- The provider ID is `traecli` because Paseo special-cases that ID when listing slash commands.
  See [slash commands need a borrowed provider ID](#slash-commands-need-a-borrowed-provider-id) before choosing another.

`label` is what the agent view displays, so it can say anything.

### Multiple hosts

Hosts share nothing: no processes, ports, locks, state, credentials, paths, or sessions.
Selecting a VPS in a client makes that VPS's daemon launch its own adapter and Claude process, read the VPS's Claude configuration and transcripts, and stream ACP back to the client.
The same provider ID is therefore safe to use everywhere.

The `command` path must be absolute and must exist on the selected host; it is never resolved against the client machine.

## Environment

The adapter inherits the Paseo daemon's environment.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_BIN` | Absolute path to Claude when the daemon's `PATH` cannot find `claude`. |
| `CLAUDE_CONFIG_DIR` | Existing Claude configuration, credentials, plugins, commands, skills, and transcript root. |
| `CLAUDE_TTY_ACP_STATE_DIR` | Adapter session mappings and locks; defaults to the host's XDG state directory. |
| `XDG_STATE_HOME` | Base for adapter state when `CLAUDE_TTY_ACP_STATE_DIR` is unset. |

For a systemd service, set `CLAUDE_BIN` to the output of `command -v claude` in the daemon user's login shell rather than relying on a shell-specific `PATH`.

## Sessions

Paseo session IDs stay stable even though Claude's own session ID can rotate after `/clear`.
The mapping is persisted only after the first real prompt, so provider probes leave no saved sessions behind.
Loading a session replays its transcript and launches `claude --resume` lazily on the next prompt.

Each active session owns an isolated PTY, hook route, transcript reader, permission bridge, lock, and attachment directory.
Sessions run concurrently, work inside a single session stays serialized, and a second adapter process cannot open a session that is already active on the host.
Locks left behind by dead processes are recovered automatically.

## Models and modes

The model selector offers Claude Code's rolling aliases — `inherit`, `opus`, `fable`, `sonnet`, `haiku` — plus the full catalog that Paseo's native Claude provider exposes, including explicit releases and 1M-context variants.
Claude Code has no supported way to list models without opening an interactive session, so that catalog is versioned with the adapter while the aliases keep following Claude's.

The mode selector offers Default, Accept Edits, Plan, and Auto.

Changing either control before launch changes startup flags.
Changing one while idle restarts and resumes Claude with deterministic flags, and changing one during a turn is rejected.

## Prompt content

Images and embedded resources become mode-0600 host-local files for the duration of a turn.
Host-local file links become `@path` references.
Audio and remote resource links are rejected with an explicit error.

## How it works

```text
Paseo ──ACP over stdio──► claude-tty-acp ──keystrokes over a PTY──► claude
                               ▲    ▲
        hooks over loopback HTTP┘    └transcript JSONL, polled
```

The daemon starts one adapter process per provider connection, and that process speaks ACP as newline-delimited JSON on stdout while its structured logs go to stderr.
Every session of that connection lives in that one process, and each session owns its own `claude` process in a PTY.

A session starts empty: `session/new` returns an ID immediately and launches nothing, so a provider probe or an untouched draft never spawns Claude.
The first prompt launches `claude --session-id <id>` and later launches reuse `claude --resume <id>`, with the model and mode selectors translated into `--model` and `--permission-mode`.

Every launch gets a private runtime directory holding a generated `settings.json` and hook client, passed with `--settings`, so the adapter registers its hooks and its status line without touching the user's Claude configuration.
No global hooks are required; remove any legacy hooks left in `~/.claude/settings.json` after uninstalling the old panel plugin.
Startup is complete once the `SessionStart` hook has arrived and Claude's interactive prompt appears on a headless xterm screen that mirrors the PTY; that screen is used only for readiness, workspace-trust detection, confirming a prompt left the input box, and the terminal snapshot in startup errors.
If Claude stops first at its workspace-trust screen, the adapter surfaces the exact cwd as an ACP permission card in Paseo.
Approving the card selects **Yes, I trust this folder** in the PTY and gives Claude a fresh startup window; denying or cancelling it fails closed without changing Claude's trust state.

Slash commands are the one thing the adapter never asks Claude for: an interactive session has no way to list them, so the adapter walks the user's, the project's and every enabled plugin's command and skill directories itself and publishes the result as ACP available commands.

### Prompts go in as keystrokes

A prompt is flattened into one block of text: images and embedded resources become files in the runtime directory referenced as `@path`, and host-local resource links become `@path` directly.
The adapter writes that text into the PTY wrapped in bracketed paste, waits briefly, then writes Enter, exactly as a person pasting into the terminal would.
The paste ends with a space so Claude's completion menu is closed rather than swallowing that Enter, and the adapter watches its input box on the headless screen and presses Enter again while the prompt is still sitting there, because Claude drops the key while it is settling a paste.

Cancellation is the same kind of impersonation: an Escape keystroke, plus a short fallback that ends the turn when no `Stop` hook follows.
Changing the model or mode while idle sends Ctrl-D, waits for the process to exit, and relaunches with `--resume`, which is why the change survives as a real flag rather than an in-band command.

### Output comes out of the transcript

Nothing that reaches Paseo is scraped from the terminal.
Claude appends its own JSONL transcript under its projects directory, and the adapter tails that file by byte offset every 40ms, re-reading from the start when the first bytes of the file change because Claude rewrote or replaced it.

A translator turns each record into an ACP session update — user and agent chunks, thinking, tool calls with diffs and file locations, `TodoWrite` into a plan, token usage into a context-window update — and dedupes by record key so re-reads and history replay never emit the same thing twice.
Loading a persisted session runs that translator over the whole file to rebuild the conversation, and still launches nothing until the next prompt.

### Hooks carry everything interactive

The adapter runs a single loopback HTTP server whose URL carries a per-process secret and a per-session route, and the generated hook client posts each hook payload to it and hands the JSON answer back to Claude.

`Stop`, `StopFailure` and `SessionEnd` end the turn with `end_turn`, `refusal` and `cancelled`, each first flushing the transcript until the file stops growing so the updates land before the turn does.

`PermissionRequest` becomes an ACP permission request offering Allow once, Claude's own permission suggestions as always-allow options, and Deny, and the answer becomes the hook's decision.
`PreToolUse` intercepts two tools before they run: `AskUserQuestion` renders as permission cards, and `ExitPlanMode` renders as a plan approval.

### State on disk

The state directory holds one JSON file per session, mapping the Paseo session ID to Claude's own session ID, cwd, model and mode, plus a lock file naming the process that has the session open.
Runtime directories live in the host's temporary directory, record their owner PID, and are swept on the next adapter startup if that process is gone.

## Limitations

Claude keeps its own MCP servers, plugins, skills, permissions, and `CLAUDE.md` hierarchy, but MCP servers injected by Paseo over ACP are rejected, as explained in [step 3](#3-register-the-provider).

### Slash commands need a borrowed provider ID

Paseo learns this adapter's slash commands, and with them Claude's skills, from an ACP `available_commands_update` notification.
The adapter sends it as soon as `session/new` returns, because Paseo drops any session update carrying a session ID it has not received yet.

A draft agent's composer lists commands for an agent that does not exist yet: Paseo spawns a throwaway session, reads the commands back, and closes it, waiting for that first batch only when the provider ID is one it special-cases.
`traecli` is such an ID, and its client differs from the generic one only by waiting up to 10 seconds, which is why this provider borrows it.
Under any other ID the composer stays empty until the agent has taken its first turn, after which the live session has the commands cached.

The configured label is what users see, so the borrowed ID stays invisible, but a genuine Trae CLI provider cannot be registered next to it and a future Paseo release may drop the special case.

Related, a draft must carry a model ID that is not literally `default`: Paseo reads `default` as "no model selected" and returns an empty list before the adapter ever launches, which is why the pass-through entry is named `inherit` instead.

### Questions arrive as permission cards

Claude's `AskUserQuestion` tool cannot use Paseo's native question and chooser UI while an external provider is selected, because Paseo's generic ACP provider exposes only the standard ACP permission request path.
The adapter renders each question as a permission card with an action per answer: single-select answers work through those actions, and multi-select questions repeat the card until Done is selected.
Choose *Answer this question in chat* when an answer needs free-form text; the adapter defers that question, continues through the remaining cards, preserves their answers, and asks Claude to restate only the deferred questions before waiting for the next normal message.

The native chooser is available only to Paseo's direct providers, because plugins cannot intercept or transform ACP requests, contribute permission renderers, or emit native agent question events.
Supporting it here requires Paseo's generic ACP provider to implement ACP `session/elicitation`, or a Paseo-specific equivalent, and return structured answers to the adapter.

### Prompts sent mid-turn interrupt the turn

Paseo cannot steer a running turn on an external provider: an ACP session offers `session/prompt` and `session/cancel` and nothing that injects text into a turn that is already in flight.
Sending a prompt while Claude is working therefore takes Paseo's replace path, which cancels the active turn, waits for the pending `session/prompt` to answer, and starts the new turn once it does.

The adapter cancels the way a person would, by sending Escape into the PTY, and ends the turn as soon as Claude's `Stop` hook confirms the interrupt or, when no hook follows, after a short fallback.
Both settle inside the 2 second budget Paseo allows before it gives up and fails the replacement with `A foreground turn is already active`.

So a mid-turn prompt discards whatever Claude was doing rather than queueing behind it the way typing into the Claude CLI does, and Claude sees the interruption in its own transcript.
If Escape has not taken effect by the time the fallback fires, Claude also queues the replacement itself and answers it after the interrupted work unwinds.
Real steering would need Paseo's generic ACP provider to offer external providers an entrypoint for it.

### Auto mode can hang on the denial limit

Auto mode decides permissions with a classifier, and after 3 consecutive or 20 total classifier denials Claude Code stops deciding and asks the person at the keyboard instead.
That escalation deliberately bypasses every remote channel — the `PermissionRequest` hook, Claude's bridge, and its channel callbacks — so the adapter is never consulted and Paseo shows no permission card.
Claude then waits at a dialog inside its PTY and no `Stop` hook follows, so the turn never finishes: the first escalation in a session denies itself after 2 minutes, and every later one waits indefinitely.

Cancel the turn from Paseo to recover, which sends Escape into the PTY and dismisses the dialog; sending a new prompt does the same, because Paseo cancels before it replaces the turn.
Default mode avoids the limit entirely, because there every decision reaches the adapter through the `PermissionRequest` hook.
Claude does report the wait over its `Notification` hook, which the adapter does not register yet, so a future release can surface the dialog or end the turn with an explicit error instead of hanging.

### The token usage meter stays empty, so the reading goes in the conversation

Paseo's token usage meter renders only once it knows both a context window size and the tokens currently in it, and it fills those in for its own providers alone.
ACP carries the pair as a `usage_update` session notification, which Paseo's generic ACP provider validates and then discards, so nothing an external provider reports can reach the meter.

The adapter reports a `Context: 137.4k tokens (69%)` line at the end of a turn instead, and stays silent until Claude has reported one.

Both numbers are Claude's own, because neither can be reconstructed.
The transcript records per-message `usage` counts but nothing about the window holding them: no record type in it carries a context window at all, and its `message.model` drops the `[1m]` marker that separates a 200k session from a 1M one, so a model ID read from there implies nothing.
Nor is the size a table the adapter could keep, because Claude resolves it per session from `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, a `native_1m` flag in its model catalog, the deployment behind the model, a 1M beta header and a clamp back to 200k.
Hooks do not carry it either; their shared payload stops at `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type` and `effort`.

The status line is where Claude does report it, so the generated `settings.json` registers one.
Claude runs a status line command through a shell and renders its stdout, so the command is `cat > <runtime directory>/context.json`: one `cat`, and no output to land on the terminal screen.
It runs when the reading changes rather than on a timer, which is at least once per assistant response: usage moves on every tool result too, so a tool-heavy turn costs several `cat`s rather than one.

Registering one is not free of the screen, though: Claude drops most of its footer hints once a status line exists, `? for shortcuts` among them, and that was the first signal `isReadyScreen` looked for.
Readiness now rests on the mode indicator, which Claude shows in every mode and writes as `manual mode on` in the default one, because the token badge is absent until a session has context and the bare prompt marker does not match while the input box still holds its placeholder.

Claude renders that line *after* the `Stop` hook, measured at about 320ms, so reading the file when the turn ends yields the turn before it.
The adapter notes the file's mtime as the hook arrives and then waits, for up to a second, for a rewrite that moves it, staying silent when none does.
The mtime is taken at the hook rather than at the read because draining the transcript and delivering the turn's last message both run in between and can outlast Claude's refresh, and it is compared against itself rather than against `Date.now()` because Linux stamps files from a coarse clock that can date a write milliseconds before the wall clock that observed it.
The timestamp rather than the contents is what marks a reading as this turn's, because two turns that land on the same numbers write identical files.
Claude truncates the file before each rewrite, so a torn read is waited out rather than reported, and a cancelled turn skips the wait entirely because Paseo allows only 2s for the prompt it is replacing to answer.

That wait is what the turn's own completion is held on, so a session that never reports would otherwise pay it forever: after three turns without a reading it stops waiting and only looks, which costs a `stat`, and says so once in the log.
Looking alone cannot find a reading written after the Stop hook, which is the whole reason the wait exists, so one turn in four keeps waiting properly and a session that starts reporting again is picked up rather than written off.
A wait a stop ended counts towards none of this, because a cancelled wait says nothing about whether Claude reports at all.

The line is a turn-boundary sample rather than a live meter, and it is not part of the session's history: the adapter generates it, so it never enters Claude's transcript and a reloaded session replays without any of the readings it showed while you worked.
The session title is not an alternative either: Paseo keeps an ACP `session_info_update` title in `runtimeInfo().extra`, which its own clients never read and which does not emit state when it changes.
Filling the real meter needs Paseo's generic ACP provider to honour `usage_update` the way its direct providers do, mapping it onto the `contextWindowMaxTokens` and `contextWindowUsedTokens` its `AgentUsage` already carries.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `Could not start claude` | Set `CLAUDE_BIN` to an absolute executable path visible to the daemon. |
| Workspace trust permission appears | Approve only when the displayed folder is a project you created or trust; Claude remembers the choice. |
| SessionStart handshake timeout | If no workspace trust card appeared, check Claude organization hook policy, inherited settings, loopback access, and the terminal snapshot in adapter stderr. |
| Claude opens a login screen | Authenticate as the Paseo daemon user and verify `HOME` or `CLAUDE_CONFIG_DIR`. |
| Persisted session not found | Select the host that created it and verify `CLAUDE_TTY_ACP_STATE_DIR`. |
| Session belongs to another cwd | Load it with its original absolute project path. |
| Session already active | Close the other native agent connection; remove a lock only after verifying its recorded PID is dead. |
| `A foreground turn is already active` | The interrupted turn had not settled when Paseo started its replacement; send the prompt again. |
| Turn never finishes in Auto mode | Claude is waiting at a keyboard-only dialog after the classifier denial limit; cancel the turn and prefer Default mode. |
| PTY exits unexpectedly | Inspect structured adapter stderr and run Claude interactively in the same cwd and environment. |
| Corrupt transcript or state | Preserve the file for diagnosis, then move only the named session JSON or transcript aside before retrying. |
| Commands or plugins missing | Verify the daemon sees the expected `CLAUDE_CONFIG_DIR`, project `.claude` files, and enabled plugin settings. |

## Development

The executable writes ACP only to stdout and sends structured diagnostics to stderr, so stderr is the place to look when something misbehaves.

Check a host without starting ACP:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp diagnose
```

`--json` prints the same checks as one machine-readable line instead of the report, for a caller that wants to act on them rather than read them:

```sh
apps/claude-tty-acp/bin/claude-tty-acp --diagnose --json
```

The line is `{ "version", "ok", "checks": [{ "id", "label", "ok", "detail" }] }`, the check IDs are `node`, `claude`, `config` and `state`, and the exit code is 1 when any check fails, exactly as without `--json`.

Run the automated checks, none of which consume Claude usage:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp typecheck
pnpm --filter @paseo-plugins/claude-tty-acp test
pnpm --filter @paseo-plugins/claude-tty-acp build
```

Run a real end-to-end smoke test through ACP and an interactive Claude PTY:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp smoke:live -- /absolute/project/path
```

The live smoke test asks Claude for a fixed tool-free response and consumes normal Claude usage.

## Upgrading and uninstalling

Upgrade each host independently, then restart the Paseo daemon:

```sh
cd /opt/paseo-plugins
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
```

Persistent session files are versioned and survive upgrades in the configured state directory.

To uninstall, remove the provider from the host's Paseo configuration, restart the daemon, and delete the source checkout once no other app or plugin uses it.
Remove the host's `claude-tty-acp` state directory only if the session resume mappings are no longer needed.
