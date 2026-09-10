import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import {
  setEnabledHandler,
  setProjectLevelHandler,
  setSettingsHandler,
  statusHandler,
} from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(contracts.getStatus, () => statusHandler());
  server.handle(contracts.setSettings, (input) => setSettingsHandler(input));
  server.handle(contracts.setEnabled, (input) => setEnabledHandler(input));
  server.handle(contracts.setProjectLevel, (input) => setProjectLevelHandler(input));

  return () => {};
}
