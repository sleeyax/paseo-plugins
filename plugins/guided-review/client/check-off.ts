import { useRpc } from "@getpaseo/plugin/client";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useState } from "react";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import type { Inbox, InboxItem } from "../shared/inbox.ts";

export const INBOX_QUERY_KEY = [PLUGIN_ID, "inbox"];
const MUTATION_KEY = [PLUGIN_ID, "check-off"];

export type CheckOffControl = {
  toggle(item: InboxItem): void;
  /** The rows checked off or unchecked since the list was last refreshed, filtered or searched, which stay where they are until then. */
  held: ReadonlySet<string>;
  release(): void;
  /** A check-off is being saved, so a refresh now could read the list from before it. */
  saving: boolean;
  /** Why the latest check-off could not be kept, as a sentence. */
  error: string | null;
};

/**
 * Checking reviews off the list and unchecking them.
 * A toggle shows at once in the listed inbox and is saved behind it, and put back if the save fails.
 */
export function useCheckOff(): CheckOffControl {
  const setCheckedOff = useRpc(contracts.setCheckedOff);
  const queryClient = useQueryClient();
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const mark = (url: string, checkedOff: boolean) =>
    queryClient.setQueryData<Inbox>(INBOX_QUERY_KEY, (inbox) =>
      inbox && { ...inbox, items: inbox.items.map((item) => (item.url === url ? { ...item, checkedOff } : item)) },
    );
  const save = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: setCheckedOff,
    onError: (failure, { url, checkOff }) => {
      mark(url, checkOff === null);
      setError(failure instanceof Error ? failure.message : String(failure));
    },
  });
  const saving = useIsMutating({ mutationKey: MUTATION_KEY }) > 0;

  return {
    toggle(item) {
      const checkedOff = !item.checkedOff;
      void queryClient.cancelQueries({ queryKey: INBOX_QUERY_KEY });
      mark(item.url, checkedOff);
      setHeld((rows) => new Set(rows).add(item.url));
      setError(null);
      save.mutate({ url: item.url, checkOff: checkedOff ? { headSha: item.headSha, state: item.state } : null });
    },
    held,
    release: () => setHeld(new Set()),
    saving,
    error,
  };
}

/** What a row's checkbox needs from the list, so the column's cell takes no more than every other cell. */
export const CheckOffContext = createContext<{ toggle(item: InboxItem): void; dimmed(item: InboxItem): boolean }>({
  toggle: () => {},
  dimmed: () => false,
});
