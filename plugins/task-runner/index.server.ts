import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { discoverTasks } from "./server/discovery/discover.ts";
import { InferredTargets } from "./server/discovery/inferred-targets.ts";
import { createPaseoTerminals } from "./server/runs/paseo-terminals.ts";
import { TaskRuns } from "./server/runs/task-runs.ts";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ID } from "./shared/identity.ts";
import { settingsDocument } from "./shared/settings.ts";

const OK = { ok: true } as const;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDocument);

  // `paseo` only arrives with a handler's context, and it is one connection for the whole process.
  let paseo: PaseoApi | null = null;
  const connection = (): PaseoApi => {
    if (paseo === null) throw new Error("Paseo is not connected to the plugin yet.");
    return paseo;
  };
  const runs = new TaskRuns({ terminals: createPaseoTerminals(connection) });
  const inferred = new InferredTargets();

  const wantsInferredTargets = async (workspaceId: string) => {
    const state = await settings.read();
    return state.status === "ready" && state.values.inferredTargetWorkspaces.includes(workspaceId);
  };

  /** Answers `contract` with `method`, keeping the connection the call came in on. */
  const serve = <Input extends ZodType, Output extends ZodType>(
    contract: PluginRpcContract<Input, Output>,
    method: (input: ZodOutput<Input>, api: PaseoApi) => Promise<ZodInput<Output>>,
  ) =>
    server.handle(contract, (input, context) => {
      paseo = context.paseo;
      return method(input, context.paseo);
    });

  serve(contracts.listTasks, async ({ workspaceId }, api) => {
    if (process.platform === "win32") {
      return { kind: "unsupported" as const, message: "Task Runner does not support Windows hosts yet." };
    }
    const workspace = await api.workspaces.ref(workspaceId).refresh();
    if (workspace === null) throw new Error("This workspace no longer exists.");
    const { tasks, nx } = await discoverTasks({
      root: workspace.workspaceDirectory,
      inferred: (await wantsInferredTargets(workspaceId)) ? inferred : undefined,
      log: (message) => console.warn(`${PLUGIN_ID}: ${message}`),
    });
    return { kind: "ready" as const, tasks, nx };
  });

  serve(contracts.getRuns, async ({ workspaceId }) => ({ runs: await runs.states(workspaceId) }));

  serve(contracts.runTask, async ({ workspaceId, task }) => {
    await runs.run(workspaceId, task);
    return OK;
  });

  serve(contracts.stopTask, async ({ workspaceId, terminalId }) => {
    await runs.stop(workspaceId, terminalId);
    return OK;
  });

  serve(contracts.forceKillTask, async ({ terminalId }) => {
    await runs.forceKill(terminalId);
    return OK;
  });

  return () => {};
}
