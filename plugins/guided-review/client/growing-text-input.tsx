import React, { useLayoutEffect, useRef, useState } from "react";
import { Platform, TextInput, type TextInputProps } from "react-native";

export type GrowingTextInputProps = Omit<TextInputProps, "multiline" | "value"> & {
  value: string;
  minHeight: number;
  /** Past this the input scrolls instead. */
  maxHeight: number;
};

/**
 * A multiline input that grows with its text, from `minHeight` up to `maxHeight`.
 * A native one does so by itself; the web's textarea keeps its height, so there it is measured on every change.
 */
export function GrowingTextInput({ value, minHeight, maxHeight, style, ...props }: GrowingTextInputProps) {
  const ref = useRef<TextInput>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    // On the web a text input's ref is its textarea.
    const node = ref.current as unknown as HTMLTextAreaElement | null;
    if (node === null) return;
    // A textarea's scrollHeight never reports less than its own height, so it is collapsed to read what the text needs.
    const shown = node.style.height;
    node.style.height = "0px";
    const needed = node.scrollHeight + node.offsetHeight - node.clientHeight;
    node.style.height = shown;
    setHeight(needed);
  }, [value]);

  return (
    <TextInput
      ref={ref}
      {...props}
      value={value}
      multiline
      style={[style, { minHeight, maxHeight }, height === undefined ? null : { height }]}
    />
  );
}
