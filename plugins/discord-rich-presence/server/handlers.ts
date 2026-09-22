import type { PresenceService, PresenceStatus } from "./service.ts";

export function statusHandler(service: PresenceService): PresenceStatus {
  return service.status();
}
