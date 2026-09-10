import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { ConfirmButton } from "./confirm.tsx";
import { Monospace } from "./status.tsx";
import { Disclosure, Row, Switch } from "./ui.tsx";

export function UninstallSection({ palette, onSettled }: { palette: Palette; onSettled: () => void }) {
  const queryClient = useQueryClient();
  const runUninstall = useRpc(contracts.runUninstall);
  const [removeState, setRemoveState] = useState(false);
  const uninstall = useMutation({
    mutationFn: (input: { removeState: boolean }) => runUninstall(input),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSettled();
    },
  });

  return (
    <Disclosure palette={palette} title="Danger zone" summary="Remove the provider">
      <View style={{ padding: spacing[4], gap: spacing[3] }}>
        <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
          Removes the provider entry this plugin wrote, so Paseo stops offering the interactive Claude
          agent on this host. The checkout stays where it is, and Claude's own configuration,
          credentials and transcripts are never touched.
        </Text>
        <Row
          palette={palette}
          title="Also delete the state directory"
          hint="Saved sessions stop resuming. Refused while a session is open."
          trailing={
            <Switch
              palette={palette}
              value={removeState}
              onValueChange={setRemoveState}
              disabled={uninstall.isPending}
              accessibilityLabel="Also delete the state directory"
            />
          }
        />
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <ConfirmButton
            palette={palette}
            label="Remove the provider"
            confirmLabel={removeState ? "Remove it and the state" : "Remove it"}
            disabled={uninstall.isPending}
            onConfirm={() => uninstall.mutate({ removeState })}
          />
        </View>
        {uninstall.error ? <Monospace palette={palette} text={String(uninstall.error)} /> : null}
        {uninstall.data ? <Monospace palette={palette} text={uninstall.data.detail} /> : null}
      </View>
    </Disclosure>
  );
}
