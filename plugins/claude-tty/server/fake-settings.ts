import type { PluginSettingsState } from "@getpaseo/plugin/server";
import type { z } from "zod";
import { settingsDocument } from "../shared/settings.ts";
import type { Settings } from "./settings.ts";

type State = PluginSettingsState<typeof settingsDocument.schema>;

/** The host's store as tests drive it: `save` and `corrupt` notify subscribers the way a write does. */
export type FakeSettings = Settings & {
  save(values: z.input<typeof settingsDocument.schema>): Promise<void>;
  corrupt(error?: string): Promise<void>;
};

export function fakeSettings(): FakeSettings {
  let revision = 0;
  let state: State = { status: "ready", revision: "missing", values: settingsDocument.schema.parse({}) };
  const listeners = new Set<(state: State) => void | Promise<void>>();
  const publish = async (next: State) => {
    state = next;
    for (const listener of listeners) await listener(structuredClone(state));
  };
  return {
    read: async () => structuredClone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    save: (values) => publish({ status: "ready", revision: String(++revision), values: settingsDocument.schema.parse(values) }),
    corrupt: (error = "Invalid settings") => publish({ status: "invalid", revision: String(++revision), error }),
  };
}
