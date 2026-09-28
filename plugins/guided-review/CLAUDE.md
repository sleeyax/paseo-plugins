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
