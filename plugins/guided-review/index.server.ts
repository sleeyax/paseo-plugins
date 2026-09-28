import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ID } from "./shared/identity.ts";
import { settingsDocument } from "./shared/settings.ts";
import { runCommand } from "./server/command-runner.ts";
import { createGitHubForge } from "./server/forge/github.ts";
import { createGitLabForge } from "./server/forge/gitlab.ts";
import { dataDirectory } from "./server/paths.ts";
import { ReviewService } from "./server/review-service.ts";
import { readGhPath, readGlabPath } from "./server/settings.ts";
import { createPaseoWorkspaces } from "./server/workspaces/paseo.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDocument);

  // `paseo` only arrives with a handler's context, and it is one connection for the whole process,
  // so the first handler keeps it for the background jobs that outlive their RPC.
  let paseo: PaseoApi | null = null;
  const connected = (context: { paseo: PaseoApi }) => {
    paseo = context.paseo;
  };

  const service = new ReviewService({
    forges: [
      createGitHubForge({ run: runCommand, gh: () => readGhPath(settings) }),
      createGitLabForge({ run: runCommand, glab: () => readGlabPath(settings) }),
    ],
    workspaces: createPaseoWorkspaces({
      run: runCommand,
      paseo: () => {
        if (paseo === null) throw new Error("Paseo is not connected to the plugin yet.");
        return paseo;
      },
    }),
    dataDirectory: dataDirectory(),
    log: (message) => console.warn(`${PLUGIN_ID}: ${message}`),
  });

  server.handle(contracts.startReview, (input, context) => {
    connected(context);
    return service.start(input);
  });
  server.handle(contracts.getStartProgress, (input, context) => {
    connected(context);
    return service.progress(input);
  });
  server.handle(contracts.getPanel, (input, context) => {
    connected(context);
    return service.panel(input);
  });

  return () => {};
}
