import type { DetailLevel, PresenceSettings } from "../shared/presence.ts";
import { withProjectDetailLevel } from "../shared/settings.ts";
import { service, type PresenceStatus } from "./service.ts";

export function statusHandler(): Promise<PresenceStatus> {
  return service.status();
}

export function setSettingsHandler(input: PresenceSettings): Promise<PresenceStatus> {
  return service.update(input);
}

export async function setEnabledHandler(input: { enabled: boolean }): Promise<PresenceStatus> {
  const { settings } = await service.status();
  return service.update({ ...settings, enabled: input.enabled });
}

export async function setProjectLevelHandler(input: {
  rootPath: string;
  displayName: string;
  level: DetailLevel | null;
}): Promise<PresenceStatus> {
  const { settings } = await service.status();
  const next = withProjectDetailLevel(
    settings,
    { rootPath: input.rootPath, displayName: input.displayName },
    input.level,
  );
  return service.update(next);
}
