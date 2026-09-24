import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { settingsDocument } from "./shared/settings.ts";
import { defaultStateDirectory, settingsSnapshotPath } from "./server/paths.ts";
import { claudeTtyProvider } from "./server/provider.ts";
import { mirrorSettings } from "./server/settings-snapshot.ts";
import {
  doctorHandler,
  lastDoctorHandler,
  quarantineSessionHandler,
  releaseLockHandler,
  releaseStaleLocksHandler,
  removeStateHandler,
  sessionsHandler,
  statusHandler,
  stopSessionHandler,
} from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDocument);
  const snapshot = mirrorSettings(settings, settingsSnapshotPath(defaultStateDirectory()));

  // Registration has to be synchronous: the daemon reads the provider list out of the reply to its
  // initialize message, and connects the provider milliseconds later.
  server.registerProvider(claudeTtyProvider(settings, snapshot));

  server.handle(contracts.getStatus, (_input, { paseo }) => statusHandler(paseo, settings));
  server.handle(contracts.runDoctor, () => doctorHandler(settings));
  server.handle(contracts.getDoctor, () => lastDoctorHandler());
  server.handle(contracts.getSessions, (_input, { paseo }) => sessionsHandler(paseo));
  server.handle(contracts.releaseLock, (input, { paseo }) => releaseLockHandler(paseo, input));
  server.handle(contracts.quarantineSession, (input, { paseo }) => quarantineSessionHandler(paseo, input));
  server.handle(contracts.stopSession, (input, { paseo }) => stopSessionHandler(paseo, input));
  server.handle(contracts.releaseStaleLocks, (_input, { paseo }) => releaseStaleLocksHandler(paseo));
  server.handle(contracts.removeState, () => removeStateHandler());

  return () => snapshot.stop();
}
