import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import {
  doctorHandler,
  installStatusHandler,
  lastDoctorHandler,
  quarantineSessionHandler,
  readSubagentHandler,
  releaseLockHandler,
  releaseStaleLocksHandler,
  sessionsHandler,
  settingsHandler,
  startInstallHandler,
  statusHandler,
  stopSessionHandler,
  subagentsHandler,
  uninstallHandler,
} from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(contracts.getStatus, (_input, { paseo }) => statusHandler(paseo));
  server.handle(contracts.setSettings, (input, { paseo }) => settingsHandler(paseo, input));
  server.handle(contracts.startInstall, (input, { paseo }) => startInstallHandler(paseo, input));
  server.handle(contracts.getInstall, () => installStatusHandler());
  server.handle(contracts.runDoctor, (_input, { paseo }) => doctorHandler(paseo));
  server.handle(contracts.getDoctor, () => lastDoctorHandler());
  server.handle(contracts.getSessions, (_input, { paseo }) => sessionsHandler(paseo));
  server.handle(contracts.releaseLock, (input, { paseo }) => releaseLockHandler(paseo, input));
  server.handle(contracts.quarantineSession, (input, { paseo }) => quarantineSessionHandler(paseo, input));
  server.handle(contracts.stopSession, (input, { paseo }) => stopSessionHandler(paseo, input));
  server.handle(contracts.getSubagents, () => subagentsHandler());
  server.handle(contracts.readSubagent, (input) => readSubagentHandler(input));
  server.handle(contracts.releaseStaleLocks, (_input, { paseo }) => releaseStaleLocksHandler(paseo));
  server.handle(contracts.runUninstall, (input, { paseo }) => uninstallHandler(paseo, input));

  return () => {};
}
