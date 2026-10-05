import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
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
  // so the first handler keeps it for the background jobs that outlive their RPC. Hooks carry the
  // same `paseo` as handlers, and a hook can be the first to arrive.
  let paseo: PaseoApi | null = null;
  const connected = (context: { paseo: PaseoApi }) => {
    paseo = context.paseo;
  };
  const connection = (): PaseoApi => {
    if (paseo === null) throw new Error("Paseo is not connected to the plugin yet.");
    return paseo;
  };
  const log = (message: string) => console.warn(`${PLUGIN_ID}: ${message}`);

  const guideAgents = createPaseoGuideAgents({ paseo: connection, agent: () => readGuideAgent(settings) });

  const service = new ReviewService({
    forges: [
      createGitHubForge({ run: runCommand, gh: () => readGhPath(settings) }),
      createGitLabForge({ run: runCommand, glab: () => readGlabPath(settings) }),
    ],
    workspaces: createPaseoWorkspaces({ run: runCommand, paseo: connection }),
    guideAgents,
    dataDirectory: dataDirectory(),
    log,
  });

  /** Answers `contract` with `method`, keeping the connection the call came in on. */
  const serve = <Input extends ZodType, Output extends ZodType>(
    contract: PluginRpcContract<Input, Output>,
    method: (input: ZodOutput<Input>) => Promise<ZodInput<Output>>,
  ) =>
    server.handle(contract, (input, context) => {
      connected(context);
      return method(input);
    });

  serve(contracts.startReview, (input) => service.start(input));
  serve(contracts.startBranchReview, (input) => service.startBranch(input));
  serve(contracts.getStartProgress, (input) => service.startProgress(input));
  serve(contracts.getInbox, () => service.inbox());
  serve(contracts.getLocalReviews, (input) => service.localReviews(input));
  serve(contracts.getInboxPreferences, () => service.inboxPreferences());
  serve(contracts.saveInboxPreferences, (input) => service.saveInboxPreferences(input));
  serve(contracts.setCheckedOff, (input) => service.setCheckedOff(input));
  serve(contracts.getPanel, (input) => service.panel(input));
  serve(contracts.generateGuide, (input) => service.generateGuide(input));
  serve(contracts.checkHead, (input) => service.checkHead(input));
  serve(contracts.regenerateGuide, (input) => service.regenerate(input));
  serve(contracts.askAbout, (input) => service.ask(input));
  serve(contracts.askQuestion, (input) => service.askQuestion(input));
  serve(contracts.getNodeDiff, (input) => service.nodeDiff(input));
  serve(contracts.getSyntaxColors, (input) => service.syntaxColors(input));
  serve(contracts.listSyntaxThemes, () => service.syntaxThemes());
  serve(contracts.getProgress, (input) => service.readingProgress(input));
  serve(contracts.setUnderstood, (input) => service.setUnderstood(input));
  serve(contracts.listDrafts, (input) => service.listDrafts(input));
  serve(contracts.createDraft, (input) => service.createDraft(input));
  serve(contracts.updateDraft, (input) => service.updateDraft(input));
  serve(contracts.deleteDraft, (input) => service.deleteDraft(input));
  serve(contracts.suggestWording, (input) => service.suggestWording(input));
  serve(contracts.getSuggestion, (input) => service.suggestion(input));
  serve(contracts.getFinish, (input) => service.finish(input));
  serve(contracts.saveReviewBody, (input) => service.saveReviewBody(input));
  serve(contracts.submitReview, (input) => service.submit(input));
  serve(contracts.discardReview, (input) => service.discard(input));

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
