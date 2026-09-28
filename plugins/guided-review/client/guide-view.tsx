import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { Pressable, Text, View } from "react-native";
import type { Guide, GuideDecision, GuideNode, GuideState } from "../shared/guide.ts";
import { NodeCode } from "./diff-view.tsx";
import { fontSize, leading, radius, spacing } from "./theme.ts";

type Colors = PluginTheme["colors"];

export type GuideViewProps = {
  reviewId: string;
  state: GuideState;
  theme: PluginTheme;
  /** Opens the guide agent's chat; absent on hosts without client navigation. */
  openAgent?: (agentId: string) => void;
  retry: { run: () => void; pending: boolean; error: string | null };
};

/** The guide under the header: its generation while it runs, its failure with a retry, or the guide itself. */
export function GuideView({ reviewId, state, theme, openAgent, retry }: GuideViewProps) {
  const colors = theme.colors;
  const agentLink =
    state.agentId !== null && openAgent ? (
      <Link colors={colors} label="Open the guide agent" onPress={() => openAgent(state.agentId!)} />
    ) : null;

  switch (state.status) {
    case "generating":
      return (
        <Card colors={colors}>
          <Body colors={colors} muted>
            Generating the guide… The guide agent is reading the change; a large one takes a few minutes.
          </Body>
          {agentLink}
        </Card>
      );
    case "failed":
      return (
        <Card colors={colors}>
          <Body colors={colors} color={colors.statusDanger}>
            {state.message}
          </Body>
          {retry.error ? (
            <Body colors={colors} color={colors.statusDanger}>
              {retry.error}
            </Body>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[3] }}>
            <Button colors={colors} label={retry.pending ? "Starting…" : "Try again"} disabled={retry.pending} onPress={retry.run} />
            {agentLink}
          </View>
        </Card>
      );
    case "ready":
      return (
        <>
          <Overview guide={state.guide} colors={colors} />
          {agentLink ? <View style={{ alignItems: "flex-start" }}>{agentLink}</View> : null}
          <Heading colors={colors}>Concepts</Heading>
          {state.guide.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              colors={colors}
              code={<NodeCode reviewId={reviewId} agentId={state.agentId} nodeId={node.id} theme={theme} />}
            />
          ))}
        </>
      );
  }
}

function Overview({ guide, colors }: { guide: Guide; colors: Colors }) {
  const { overview } = guide;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  return (
    <Card colors={colors}>
      <Label colors={colors}>The idea</Label>
      <Body colors={colors}>{overview.idea}</Body>
      {overview.needToKnows.length > 0 ? (
        <>
          <Label colors={colors}>Need to know</Label>
          {overview.needToKnows.map((item, index) => (
            <Bullet key={index} colors={colors}>
              {item}
            </Bullet>
          ))}
        </>
      ) : null}
      {overview.decisions.length > 0 ? (
        <>
          <Label colors={colors}>Decisions</Label>
          <Decisions decisions={overview.decisions} colors={colors} />
        </>
      ) : null}
      <Label colors={colors}>Where to spend your attention</Label>
      {overview.attention.map((entry, index) => (
        <Bullet key={index} colors={colors}>
          <Text style={{ fontWeight: "600" }}>{titles.get(entry.nodeId) ?? entry.nodeId}</Text>: {entry.reason}
        </Bullet>
      ))}
    </Card>
  );
}

/** A node: what it is and how it works, then the code it covers (`code`). */
function NodeCard({ node, colors, code }: { node: GuideNode; colors: Colors; code: React.ReactNode }) {
  return (
    <Card colors={colors}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base), fontWeight: "600" }}>
        {node.title}
      </Text>
      <Body colors={colors} muted>
        {node.summary}
      </Body>
      <Body colors={colors}>{node.explanation}</Body>
      {node.decisions.length > 0 ? <Decisions decisions={node.decisions} colors={colors} /> : null}
      {code}
    </Card>
  );
}

function Decisions({ decisions, colors }: { decisions: readonly GuideDecision[]; colors: Colors }) {
  return (
    <>
      {decisions.map((decision, index) => (
        <Bullet key={index} colors={colors}>
          {decision.choice}
          <Text style={{ color: colors.foregroundMuted }}> Rather than: {decision.rejected}</Text>
        </Bullet>
      ))}
    </>
  );
}

function Card({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

function Heading({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <Text
      style={{ color: colors.foreground, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg), fontWeight: "600", marginTop: spacing[2] }}
    >
      {children}
    </Text>
  );
}

function Label({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <Text
      style={{
        color: colors.foregroundMuted,
        fontSize: fontSize.sm,
        lineHeight: leading(fontSize.sm),
        fontWeight: "600",
        marginTop: spacing[1],
      }}
    >
      {children}
    </Text>
  );
}

function Body({ colors, muted, color, children }: { colors: Colors; muted?: boolean; color?: string; children: React.ReactNode }) {
  return (
    <Text style={{ color: color ?? (muted ? colors.foregroundMuted : colors.foreground), fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
      {children}
    </Text>
  );
}

function Bullet({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing[2] }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>•</Text>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{children}</Text>
    </View>
  );
}

function Link({ colors, label, onPress }: { colors: Colors; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link">
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}

function Button({ colors, label, disabled, onPress }: { colors: Colors; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingVertical: spacing[1],
        paddingHorizontal: spacing[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{label}</Text>
    </Pressable>
  );
}
