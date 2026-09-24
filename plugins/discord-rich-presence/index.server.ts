import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as contracts from "./shared/contracts.ts";
import { settingsDocument } from "./shared/settings.ts";
import { statusHandler } from "./server/handlers.ts";
import { PresenceService } from "./server/service.ts";

export default function contribute(server: PluginServerContext) {
  const service = new PresenceService(server.registerSettings(settingsDocument));
  void service.start().catch((error: unknown) => {
    console.error("discord-rich-presence failed to start", error);
  });

  server.handle(contracts.getStatus, () => statusHandler(service));

  return () => service.stop();
}
