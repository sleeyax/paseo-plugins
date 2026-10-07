import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences } from "../shared/inbox-preferences.ts";

export type InboxPreferencesControl = {
  preferences: InboxPreferences;
  change(update: Partial<InboxPreferences>): void;
  /** Why the latest change could not be kept, as a sentence. */
  error: string | null;
};

const QUERY_KEY = [PLUGIN_ID, "inbox-preferences"];

/**
 * The review list's filters, sort and columns as the daemon keeps them. A change shows at once and
 * is saved whole behind it; the answer is not read back, since a slower answer to an earlier save
 * would undo a later change.
 */
export function useInboxPreferences(): InboxPreferencesControl {
  const getPreferences = useRpc(contracts.getInboxPreferences);
  const savePreferences = useRpc(contracts.saveInboxPreferences);
  const queryClient = useQueryClient();
  const stored = useQuery({ queryKey: QUERY_KEY, queryFn: () => getPreferences({}), staleTime: Infinity });
  const save = useMutation({ mutationFn: savePreferences });

  return {
    preferences: stored.data ?? DEFAULT_INBOX_PREFERENCES,
    change(update) {
      const next = { ...(queryClient.getQueryData<InboxPreferences>(QUERY_KEY) ?? DEFAULT_INBOX_PREFERENCES), ...update };
      queryClient.setQueryData(QUERY_KEY, next);
      save.mutate(next);
    },
    error: save.isError ? (save.error instanceof Error ? save.error.message : String(save.error)) : null,
  };
}
