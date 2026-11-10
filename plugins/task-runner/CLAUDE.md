# Working on this plugin

Run `paseo plugin reload task-runner` after every change, then `paseo plugin logs task-runner`.
The reload is the only compile check of the two bundles the daemon builds.

## Traps

- A dependency whose entry is a UMD build fails at load with `Cannot find module`, because the daemon's bundler cannot follow its dynamic `require`, while typecheck and tests pass.
  `jsonc-parser` is one, which is why `server/discovery/files.ts` reads JSONC itself.
- A change to `WRAPPER` in `server/runs/shell-wrapper.ts` has to be tried on real terminals with both zsh and bash, with a single-command task and with Ctrl+C.
- `pnpm test` runs `node --test` with Node's type stripping: write only erasable TypeScript and keep the `.ts` extension on relative imports.
