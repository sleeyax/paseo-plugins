import React from "react";
import { Text } from "react-native";
import { MONO_FONT } from "./diff-view.tsx";
import { parseInline, type Span } from "./inline-markdown.ts";
import { fontSize, radius, type Colors } from "./theme.ts";

/** Text the guide agent wrote, in which it uses inline Markdown; it draws inside the `Text` that styles the paragraph. */
export function GuideText({ text, colors }: { text: string; colors: Colors }) {
  return (
    <>
      {parseInline(text).map((span, index) => (
        <Text key={index} style={spanStyle(span, colors)}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

function spanStyle(span: Span, colors: Colors) {
  return {
    ...(span.strong ? { fontWeight: "600" as const } : {}),
    ...(span.emphasis ? { fontStyle: "italic" as const } : {}),
    ...(span.code ? { fontFamily: MONO_FONT, fontSize: fontSize.sm, color: colors.foreground, backgroundColor: colors.surface2, borderRadius: radius.md } : {}),
  };
}
