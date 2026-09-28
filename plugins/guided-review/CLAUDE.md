# Working on this plugin

Run `paseo plugin reload guided-review` after every change, then `paseo plugin logs guided-review`.
The reload is the only compile check of the two bundles the daemon builds.
Do this yourself; never leave it to the user.
Where a reload is not wanted, the daemon's own compiler answers the same question: import `compilePlugin` from `@getpaseo/server/dist/server/server/plugins/compiler.js` (inside the CLI's `node_modules`) and run it over the two entries.

## The shape later work builds on

`server/review-service.ts` is the top level: every RPC in `shared/contracts.ts` is one of its methods, and `index.server.ts` does nothing but wire them.
It reaches the outside only through its ports, so its tests replace every one of them:

- `server/forge/port.ts` is the Forge port. `server/forge/github.ts` implements it over `gh` and `server/forge/gitlab.ts` over `glab`, both through `server/forge/cli.ts`, which turns a failed call into a `ForgeError` whose message is shown as it is.
- `server/workspaces/port.ts` is the workspace port. `server/workspaces/paseo.ts` implements it over the SDK.
- `server/command-runner.ts` is the one seam every `gh`, `glab` and `git` call goes through, and `server/fake-command-runner.ts` replays recorded output through it.
- `server/guide-agent/port.ts` is the guide agent port, which moves text only: `create` starts the agent on a prompt, `reply` waits for its answer, `run` and `send` prompt it again (for "Suggest wording" and "Ask about this"), `status` says whether it is idle. `server/guide-agent/paseo.ts` implements it over the SDK. Structured output is `server/guide-agent/structured.ts`: `withOutputSchema` puts the JSON Schema in the prompt, `parseReply` finds the JSON in the reply and validates it with zod, and `runStructured` does both for a `{ body }`-style request. `server/guide-output.ts` adds the guide's own checks, which is where layering and coverage go.

A new forge operation goes on the port first, then on each adapter; a new RPC goes in `shared/contracts.ts` and becomes a service method.
The fakes (`server/fake-*.ts`) sit beside the modules rather than in tests so every test shares them, and nothing in `index.server.ts` imports them, so they never reach the bundle.

## Constraints that are not obvious

A Command Center item cannot take text, so the global item opens the `start` surface, which holds the URL field.
A surface is not handed the client context, so `createStartSurface` takes the panel opener through its closure, and `client/open-panel.ts` retries it: `client.openPanel` throws until the app's cache has the workspace, which a just-created one reaches a moment later.

Paseo cuts every plugin RPC off after 30 seconds and does not stop the handler.
Reading a PR, cloning and `workspaces.create` can all take longer, so `start` returns a review ID at once and the work runs as a background job the start surface polls through `progress`.
`paseo` only arrives on a handler's context; it is one connection for the whole process, so `index.server.ts` keeps the first one for the jobs that outlive their RPC.

A `change_request` workspace is a worktree of an existing clone, and the daemon fetches the PR from that clone's `origin`.
So the clone is found by asking each git project for `git remote get-url origin` (a project carries no remote), and when none matches the repository is cloned with `gh repo clone` or `glab repo clone` into the data directory, which then becomes a Paseo project of its own the first time a workspace is cut from it.

Paseo passes an output schema only with a new agent's first prompt, and only Codex and OpenCode enforce it, so every structured request carries the schema in its prompt and the reply is parsed here, whatever the provider.
There is no generic read-only flag either: `readOnlyMode` picks Claude's `plan` or Codex's `read-only` (valid though unadvertised), and the `agent.permission_requested` hook denies a guide agent's edits, writes, commands and mode changes, recognising it by its `guided-review.review` label because the hook's agent carries no labels and an in-memory list would not survive a reload.
Hooks are best-effort, so `reply` answers whatever is pending itself when `waitForFinish` comes back with `status: "permission"`: in plan mode Claude tends to end by asking to leave it, which is denied with a request to answer as a normal message.
Sending to a busy agent interrupts its turn (`PaseoAgentSendOptions` has no `activeTurnBehavior`), so `run` and `send` refuse unless the agent is idle.

The guide is generated as a background job keyed by review and head SHA, and `server/review-store.ts` keeps a record per head SHA from the moment the agent is asked, with its agent ID. A panel read that finds a `generating` record with no job behind it waits on the same agent again, which is how a generation survives a plugin reload. A guide belongs to the workspace it was generated in; a new workspace for the review gets a new guide and agent.

`GuideSchema` in `shared/guide.ts` is what the agent writes; `LayeredGuideSchema` is what the store keeps and the panel shows, and only `layOutGuide` in `server/guide-output.ts` turns one into the other.
A dependency may point only at a node listed earlier, which `parseGuide` enforces and which is what makes the nodes a DAG without a cycle check; the agent never writes a layer.
Layers are longest-path from the foundations, capped at `MAX_LAYERS`: a deeper chain stays in the last layer, still in the agent's order.

A node names its code in `covers` (`shared/guide.ts`): a path, hunk numbers, or line ranges in the new file (the old one for a removed file). `covers` is the only place a node's files come from; `coveredPaths` derives the file list wherever one is wanted (coverage, the panel's Files list, "Ask about this"). The numbers are the ones `server/guide-prompt.ts` labels each hunk with ("Hunk 2"), from `splitHunks` in `server/diff.ts`, so the prompt and the parser must keep cutting patches the same way.
`server/diff.ts` parses patches into `shared/diff.ts`'s model and `resolveCode` cuts a file down to what a node covers, which `parseGuide` uses to reject references the diff lacks and the `node-diff` RPC to return a subject's hunks, parsed afresh from the snapshot at the guide's head. The RPC takes the same `GuideSubject` as "Ask about this": a node gives its `covers`, a file (a Supporting or Unsorted entry) its whole diff, as `resolveCode(files, [{ path, hunks: [], lines: [] }])`.
Every line keeps its kind, its old and new numbers, and GitLab's running counters `oldPos`/`newPos` (a `line_code` is `sha1(path)_oldPos_newPos`, and a new file's old counter is 0, as GitLab's parser has it), so a draft can be anchored from the line alone. A partly covered hunk comes back as one entry per unbroken run of lines, with `complete: false` and a header recomputed for the run; its lines still lie inside the forge's hunk, which a GitHub range needs.

Coverage only sorts what no node covers, since several nodes may cover different hunks of one file: the lockfiles and generated files `server/file-classes.ts` set aside before the prompt was built go to Supporting whatever covers them, a file some node covers any part of is placed, then the agent's Supporting entries for the rest, else Unsorted. `parseGuide` normalises paths before checking them, and nothing is retried.

"Ask about this" sends only a `GuideSubject` (a node ID or a changed file's path) to `ask`, which looks the rest up in the stored guide and snapshot and builds the prompt from an `AskSubjectContext` in `server/ask-prompt.ts`: a node with the code it covers, as `codeReferencesOf` its resolved `covers`, or a file with its Supporting category, null for Unsorted. `client/ask-action.tsx` holds `AskAction`, the one control every node and entry renders, and `useAskAbout`, which opens the agent's chat once the prompt is sent. `ask` checks `status` before `send` so a busy or gone agent gets its own message rather than the port's error.

The SDK gives a plugin no data directory. `server/paths.ts` derives one in the Paseo home, per daemon, because the workspace IDs it records mean something only to that daemon.

`server/command-runner.ts` keeps the whole of stdout, decoded once, because a truncated JSON document is worse than none; only a runaway command past 256 MiB is cut off, and that is a failure rather than a truncation.
It takes stdin for `--input -`, which is how GraphQL and JSON bodies are sent: `gh api -F` turns a repository called `123` into a number.

## GitLab through `glab`

`glab` sends a token from its environment to any `--hostname` it is given, logged in there or not, so the adapter checks each host with `glab auth status --hostname` (exit 0 means logged in) before its first call there, and `matchUrl` turns down an MR URL on any other host with a `ForgeError` the service shows as the rejection.
Every call passes `--hostname`, because `glab` otherwise picks the host from the git remote of whatever directory the daemon runs in; a host on a port cannot be one, so it is the URL's host without the port.

The adapter addresses a project by its numeric ID, looked up once per path, because some GitLab versions turn down a URL-encoded path on the draft notes endpoints.
`glab api --paginate` prints each page as a JSON array of its own, one after another, so paginated lists are read with `--output ndjson` through `Cli.ndjson`.
GitLab's REST API gives no line counts, so additions and deletions are counted from the diffs; a diff GitLab withheld as too large counts as none.
The change request keeps GitLab's `start_sha` as `startSha` beside the base and head SHAs, because a draft note's position names all three.

`glab` runs without `PASEO_AGENT_ID` and `GITLAB_BOT_IDENTITY` (`unsetEnv` on the command runner).
A `glab` wrapper can swap in a bot account's token when it sees either, and a daemon restarted from an agent's terminal inherits `PASEO_AGENT_ID`; the review is the reviewer's own, so it is read and written as them.

## Tests

`pnpm test` is `node --test "{client,server,shared}/**/*.test.ts"` through Node's type stripping, so no TypeScript that has to be emitted and relative imports keep their `.ts` extension.
`server/forge/fixtures/github/` holds real `gh` 2.101 output for sleeyax/paseo-plugins#105, with the user trimmed to its public fields.
`server/forge/fixtures/gitlab/` holds real `glab` 1.119 output for gitlab-org/cli!3931 on gitlab.com, a merged MR from a fork, recorded with read-only `glab api` calls; the user is the account `glab` happened to be logged in as, trimmed to its public fields.
Service tests use a real temp directory for the data directory, and restart the service over it to check what survives on disk.
The guide agent fake answers with fixture text (`sampleGuideReply`), or with a promise the test resolves to look at the panel mid-generation, so the real parsing runs in every service test. `server/guide-agent/paseo.test.ts` drives the SDK adapter over a stub of the slice of `PaseoApi` it uses.
