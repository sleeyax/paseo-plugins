import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { spacing, type Palette } from "./theme.ts";
import { Button } from "./ui.tsx";

/** How long an armed action waits before it disarms itself rather than sitting there primed. */
const ARMED_MS = 6_000;

/**
 * Paseo gives plugins no dialog, so a destructive action arms in place: the button is replaced by
 * the confirmation and a way out of it.
 */
export function ConfirmButton({
  palette,
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  palette: Palette;
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return <Button palette={palette} label={label} disabled={disabled} onPress={() => setArmed(true)} />;
  }
  return (
    <View style={{ flexDirection: "row", gap: spacing[2] }}>
      <Button palette={palette} label="Cancel" variant="ghost" onPress={() => setArmed(false)} />
      <Button
        palette={palette}
        label={confirmLabel}
        variant="default"
        disabled={disabled}
        onPress={() => {
          setArmed(false);
          onConfirm();
        }}
      />
    </View>
  );
}
