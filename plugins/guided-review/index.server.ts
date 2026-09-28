import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ID } from "./shared/identity.ts";
import { settingsDocument } from "./shared/settings.ts";
import { runCommand } from "./server/command-runner.ts";
import { createGitHubForge } from "./server/forge/github.ts";
import { createGitLabForge } from "./server/forge/gitlab.ts";
import { createPaseoGuideAgents } from "./server/guide-agent/paseo.ts";
import { dataDirectory } from "./server/paths.ts";
import { ReviewService } from "./server/review-service.ts";
import { readGhPath, readGlabPath, readGuideAgent } from "./server/settings.ts";
import { createPaseoWorkspaces } from "./server/workspaces/paseo.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDocument);

  // `paseo` only arrives with a handler's context, and it is one connection for the whole process,
  // so the first handler keeps it for the background jobs that outlive their RPC.
  let paseo: PaseoApi | null = null;
  const connected = (context: { paseo: PaseoApi }) => {
    paseo = context.paseo;
  };
  const log = (message: string) => console.warn(`${PLUGIN_ID}: ${message}`);

  // Hooks carry the same `paseo` as handlers, and a hook can be the first to arrive.
  const guideAgents = createPaseoGuideAgents({
    paseo: () => {
      if (paseo === null) throw new Error("Paseo is not connected to the plugin yet.");
      return paseo;
    },
    agent: () => readGuideAgent(settings),
  });

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
    guideAgents,
    dataDirectory: dataDirectory(),
    log,
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
  server.handle(contracts.generateGuide, (input, context) => {
    connected(context);
    return service.generateGuide(input);
  });
  server.handle(contracts.getNodeDiff, (input, context) => {
    connected(context);
    return service.nodeDiff(input);
  });

  // The guide agent is read-only. Its provider's plan or read-only mode is the first guard and this
  // the second, since not every provider has such a mode; the generation job answers what it misses.
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    connected(context);
    await guideAgents
      .onPermissionRequested(agent.id, request)
      .catch((error: unknown) => log(`Answering a permission request of ${agent.id} failed: ${String(error)}`));
  });
  // Paseo archives a workspace's agents with it; this makes sure of the guide agents, whose guide ends there.
  server.on("workspace.archived", async ({ workspace }, context) => {
    connected(context);
    await service
      .workspaceArchived({ workspaceId: workspace.id })
      .catch((error: unknown) => log(`Ending the guides in ${workspace.id} failed: ${String(error)}`));
  });

  return () => {};
}
