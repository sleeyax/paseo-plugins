import type { PluginTheme } from "@getpaseo/plugin";
import React, { createContext, useContext, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import type { CommentOrigin } from "../shared/drafts.ts";
import {
  coveredPaths,
  type Guide,
  type GuideDecision,
  type GuideDependency,
  type GuideState,
  type LayeredGuide,
  type LayeredNode,
} from "../shared/guide.ts";
import { EntryLinksContext } from "./entry-links.ts";
import { guideGroups, layerTitle, type Entry } from "./guide-entries.ts";
import { AskAction, type AskControl } from "./ask-action.tsx";
import { NodeCode } from "./diff-view.tsx";
import { ItemCommentBox, NodeComments, OverviewComments, useCommentOnHold, useCommentOnRelease, type Selected } from "./drafts.tsx";
import { GroupUnderstoodToggle, ProgressSummary, UnderstoodToggle, useCollapsed } from "./progress.tsx";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";
import { GuideText } from "./guide-text.tsx";
import { HIGHLIGHTS_TEXT, useHighlight } from "./text-selection.ts";

export type GuideViewProps = {
  reviewId: string;
  state: GuideState;
  theme: PluginTheme;
  /** Opens the guide agent's chat; absent on hosts without client navigation. */
  openAgent?: (agentId: string) => void;
  retry: { run: () => void; pending: boolean; error: string | null };
  /** "Ask about this" on each node, and on each Supporting and Unsorted entry. */
  ask: AskControl;
  /** Draws the progress summary above the groups, where no sidebar shows it. */
  withProgress: boolean;
};

/** The guide under the header: its generation while it runs, its failure with a retry, or the guide itself. */
export function GuideView({ reviewId, state, theme, openAgent, retry, ask, withProgress }: GuideViewProps) {
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
          <Tree reviewId={reviewId} agentId={state.agentId} guide={state.guide} theme={theme} ask={ask} withProgress={withProgress} />
        </>
      );
  }
}

/** The nodes by layer, trunk first, then Tests, Documentation, Supporting and Unsorted. */
function Tree({
  reviewId,
  agentId,
  guide,
  theme,
  ask,
  withProgress,
}: {
  reviewId: string;
  agentId: string;
  guide: LayeredGuide;
  theme: PluginTheme;
  ask: AskControl;
  withProgress: boolean;
}) {
  const colors = theme.colors;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  const code = (entry: Entry) => <NodeCode reviewId={reviewId} agentId={agentId} subject={entry.subject} theme={theme} />;
  return (
    <>
      {withProgress ? <ProgressSummary colors={colors} layerTitle={layerTitle} /> : null}
      {guideGroups(guide).map((group) => (
        <React.Fragment key={group.id}>
          <Heading colors={colors} subjects={group.entries.map((entry) => entry.subject)}>
            {group.title}
          </Heading>
          {group.kind === "layer" ? (
            group.entries.map((entry) =>
              entry.kind === "node" ? <NodeCard key={entry.key} node={entry.node} titles={titles} colors={colors} ask={ask} code={code(entry)} /> : null,
            )
          ) : (
            <Card colors={colors} light={group.kind !== "unsorted"}>
              {group.kind === "unsorted" ? <UnsortedNote colors={colors} /> : null}
              {group.entries.map((entry) => (entry.kind === "file" ? <FileEntry key={entry.key} colors={colors} entry={entry} ask={ask} code={code(entry)} /> : null))}
            </Card>
          )}
        </React.Fragment>
      ))}
    </>
  );
}

export function UnsortedNote({ colors }: { colors: Colors }) {
  return (
    <Body colors={colors} muted>
      The guide agent placed these changes nowhere, so no concept explains them. Where a concept covers part of a file, only the rest is here.
    </Body>
  );
}

/** The overview, whose text the reviewer can highlight, or hold in the phone app, to comment on. */
export function Overview({ guide, colors }: { guide: Guide; colors: Colors }) {
  const { overview } = guide;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  const { prose, text, selected } = useCardText({ kind: "overview" });
  return (
    <Card colors={colors}>
      <CardTextContext.Provider value={text}>
        <View ref={prose} style={{ gap: spacing[2] }}>
          <Label colors={colors}>The idea</Label>
          <Body colors={colors} item={{ key: "idea", text: overview.idea }}>
            <GuideText text={overview.idea} colors={colors} />
          </Body>
          {overview.needToKnows.length > 0 ? (
            <>
              <Label colors={colors}>Need to know</Label>
              {overview.needToKnows.map((item, index) => (
                <Bullet key={index} colors={colors} item={{ key: `need:${index}`, text: item }}>
                  <GuideText text={item} colors={colors} />
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
          {overview.attention.map((entry, index) => {
            const title = titles.get(entry.nodeId) ?? entry.nodeId;
            return (
              <Bullet key={index} colors={colors} item={{ key: `attention:${index}`, text: `${title}: ${entry.reason}` }}>
                <NodeLink nodeId={entry.nodeId} title={title} colors={colors} />
                : <GuideText text={entry.reason} colors={colors} />
              </Bullet>
            );
          })}
        </View>
      </CardTextContext.Provider>
      <OverviewComments colors={colors} selected={selected} />
    </Card>
  );
}

/**
 * A node, whose code (`code`) comes before its comments, which sit at the foot of the card.
 * The reviewer can highlight its text, not its code, or hold it in the phone app, to comment on.
 * A card that is not `collapsible` stands alone in the detail pane, where folding it would leave nothing to read.
 */
export function NodeCard({
  node,
  titles,
  colors,
  ask,
  code,
  collapsible = true,
}: {
  node: LayeredNode;
  titles: ReadonlyMap<string, string>;
  colors: Colors;
  ask: AskControl;
  code: React.ReactNode;
  collapsible?: boolean;
}) {
  const files = coveredPaths(node);
  const { prose, text, selected } = useCardText({ kind: "node", nodeId: node.id });
  const [folded, setCollapsed] = useCollapsed({ kind: "node", nodeId: node.id });
  const collapsed = collapsible && folded;
  return (
    <Card colors={colors}>
      <CardTextContext.Provider value={text}>
        <View ref={prose} style={{ gap: spacing[2] }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[2] }}>
            {collapsible ? <CollapseToggle colors={colors} collapsed={collapsed} onPress={() => setCollapsed(!collapsed)} /> : null}
            <Text
              selectable={HIGHLIGHTS_TEXT}
              style={{ flex: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base), fontWeight: "600" }}
            >
              <GuideText text={node.title} colors={colors} />
            </Text>
            <UnderstoodToggle subject={{ kind: "node", nodeId: node.id }} colors={colors} />
          </View>
          <Collapsible collapsed={collapsed}>
            <Body colors={colors} muted item={{ key: "summary", text: node.summary }}>
              <GuideText text={node.summary} colors={colors} />
            </Body>
            {node.dependencies.length > 0 ? <Dependencies dependencies={node.dependencies} titles={titles} colors={colors} /> : null}
            <Body colors={colors} item={{ key: "explanation", text: node.explanation }}>
              <GuideText text={node.explanation} colors={colors} />
            </Body>
            {node.decisions.length > 0 ? <Decisions decisions={node.decisions} colors={colors} /> : null}
          </Collapsible>
        </View>
      </CardTextContext.Provider>
      <Collapsible collapsed={collapsed}>
        {files.length > 0 ? (
          <>
            <Label colors={colors}>Files</Label>
            {files.map((file) => (
              <FileLine key={file} colors={colors} path={file} />
            ))}
          </>
        ) : null}
        <AskAction subject={{ kind: "node", nodeId: node.id }} ask={ask} colors={colors} />
        {code}
        <NodeComments nodeId={node.id} colors={colors} selected={selected} />
      </Collapsible>
    </Card>
  );
}

/** The nodes a node builds on: on one line when none has a reason to give, else a bullet each. */
function Dependencies({ dependencies, titles, colors }: { dependencies: readonly GuideDependency[]; titles: ReadonlyMap<string, string>; colors: Colors }) {
  const titled = dependencies.map((dependency) => ({ ...dependency, title: titles.get(dependency.nodeId) ?? dependency.nodeId }));
  if (titled.every((dependency) => dependency.reason === null)) {
    return (
      <Body colors={colors} muted item={{ key: "dependencies", text: `Builds on ${titled.map((dependency) => dependency.title).join(", ")}` }}>
        {"Builds on "}
        {titled.map((dependency, index) => (
          <React.Fragment key={dependency.nodeId}>
            {index > 0 ? ", " : null}
            <NodeLink nodeId={dependency.nodeId} title={dependency.title} colors={colors} />
          </React.Fragment>
        ))}
      </Body>
    );
  }
  return (
    <>
      <Label colors={colors}>Builds on</Label>
      {titled.map(({ nodeId, title, reason }) => (
        <Bullet key={nodeId} colors={colors} item={{ key: `dependency:${nodeId}`, text: reason === null ? title : `${title}: ${reason}` }}>
          <NodeLink nodeId={nodeId} title={title} colors={colors} />
          {reason === null ? null : (
            <>
              : <GuideText text={reason} colors={colors} />
            </>
          )}
        </Bullet>
      ))}
    </>
  );
}

/** A concept's title in another part of the guide, which selects that concept where there is a navigator to select it in. */
function NodeLink({ nodeId, title, colors }: { nodeId: string; title: string; colors: Colors }) {
  const links = useContext(EntryLinksContext);
  const key = subjectKey({ kind: "node", nodeId });
  const linked = links !== null && links.groups.some((group) => group.entries.some((entry) => entry.key === key));
  return (
    <Text
      style={{ fontWeight: "600", ...(linked ? { color: colors.accent } : {}) }}
      {...(linked ? { onPress: () => links.select(key), accessibilityRole: "link" as const } : {})}
    >
      <GuideText text={title} colors={colors} />
    </Text>
  );
}

/**
 * A Supporting or Unsorted file, which the reviewer can ask about and mark understood on its own and
 * read the diff of, since tests and wiring get review comments too: the whole of it, or the rest of a
 * file some nodes cover part of. A lockfile or a generated file starts with its diff hidden, as it is long and seldom read.
 */
export function FileEntry({
  colors,
  entry,
  ask,
  code,
  collapsible = true,
}: {
  colors: Colors;
  entry: Extract<Entry, { kind: "file" }>;
  ask: AskControl;
  code: React.ReactNode;
  collapsible?: boolean;
}) {
  const { path, category } = entry;
  // Tests and Documentation are groups of their own, so only the rest of Supporting names its category.
  const note = category === null || category === "test" || category === "docs" ? undefined : category;
  const [open, setOpen] = React.useState(category !== "lockfile" && category !== "generated");
  const [folded, setCollapsed] = useCollapsed({ kind: "file", path });
  const collapsed = collapsible && folded;
  return (
    <View style={{ gap: spacing[1] }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[2] }}>
        {collapsible ? <CollapseToggle colors={colors} collapsed={collapsed} onPress={() => setCollapsed(!collapsed)} /> : null}
        <View style={{ flex: 1 }}>
          <FileLine colors={colors} path={path} note={note} />
        </View>
        <UnderstoodToggle subject={{ kind: "file", path }} colors={colors} />
      </View>
      <Collapsible collapsed={collapsed} gap={spacing[1]}>
        <AskAction subject={{ kind: "file", path }} ask={ask} colors={colors} />
        <View style={{ alignItems: "flex-start" }}>
          <Link colors={colors} label={open ? "Hide the diff" : "Show the diff"} onPress={() => setOpen(!open)} />
        </View>
        {open ? code : null}
      </Collapsible>
    </View>
  );
}

function FileLine({ colors, path, note }: { colors: Colors; path: string; note?: string }) {
  return (
    <Text style={{ color: colors.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {path}
      {note ? <Text style={{ color: colors.foregroundMuted }}> · {note}</Text> : null}
    </Text>
  );
}

function Decisions({ decisions, colors }: { decisions: readonly GuideDecision[]; colors: Colors }) {
  return (
    <>
      {decisions.map(({ choice, alternative }, index) => (
        <Bullet
          key={index}
          colors={colors}
          item={{ key: `decision:${index}`, text: alternative ? `${choice} Author: “${alternative.quote}”` : choice }}
          sub={
            alternative ? (
              <>
                {"Author: "}
                <Text style={{ fontStyle: "italic" }}>“{alternative.quote}”</Text>
              </>
            ) : undefined
          }
        >
          <GuideText text={choice} colors={colors} />
        </Bullet>
      ))}
    </>
  );
}

/** A `light` card sits on the panel's own background rather than raised on a card surface. */
export function Card({ colors, light, children }: { colors: Colors; light?: boolean; children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: light ? colors.surface0 : colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

function CollapseToggle({ colors, collapsed, onPress }: { colors: Colors; collapsed: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={spacing[2]}
      accessibilityRole="button"
      accessibilityLabel={collapsed ? "Expand" : "Collapse"}
      accessibilityState={{ expanded: !collapsed }}
    >
      <Text style={{ width: spacing[4], color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
        {collapsed ? "▸" : "▾"}
      </Text>
    </Pressable>
  );
}

/** Hidden rather than unmounted while collapsed, so a comment box inside keeps what was typed in it. */
function Collapsible({ collapsed, gap = spacing[2], children }: { collapsed: boolean; gap?: number; children: React.ReactNode }) {
  return <View style={{ display: collapsed ? "none" : "flex", gap }}>{children}</View>;
}

/** A group's heading, with the toggle that marks every one of its `subjects` understood at once. */
function Heading({ colors, subjects, children }: { colors: Colors; subjects: readonly GuideSubject[]; children: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2], marginTop: spacing[2] }}>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg), fontWeight: "600" }}>{children}</Text>
      <GroupUnderstoodToggle group={children} subjects={subjects} colors={colors} />
    </View>
  );
}

function Label({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <Text
      selectable={HIGHLIGHTS_TEXT}
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

/** A paragraph or bullet of a card's text a comment can open under: its key within the card, and its whole text. */
type Item = { key: string; text: string };

/**
 * A card whose text takes comments: `from`, the part of the guide it shows, and `register`, which
 * records the element of each paragraph and bullet, so a highlight can be traced to the one it ends
 * in, and of each comment box drawn under one, which is no part of the text. `hold` comments on a
 * whole paragraph or bullet, which the phone app offers on a long press; null on the web.
 */
type CardText = {
  from: CommentOrigin;
  register: (part: "item" | "box", key: string, element: unknown) => void;
  hold: ((held: Selected) => void) | null;
};

/** Null outside a card whose text takes comments, and outside a review. */
const CardTextContext = createContext<CardText | null>(null);

/**
 * What a card of `from` needs for comments on its text: the element of its prose, which a highlight
 * has to lie inside, the `CardText` its paragraphs and bullets read, and what is highlighted in it.
 */
function useCardText(from: CommentOrigin): { prose: React.RefObject<View | null>; text: CardText | null; selected: Selected | null } {
  const prose = useRef<View>(null);
  const parts = useRef({ item: new Map<string, Node>(), box: new Map<string, Node>() });
  const itemOf = (end: Node) => [...parts.current.item].find(([, element]) => element.contains(end))?.[0];
  const release = useCommentOnRelease(from);
  const highlight = useHighlight(prose, {
    onRelease: release && ((found) => release({ text: found.text, item: itemOf(found.end) })),
    excluded: () => parts.current.box.values(),
  });
  const hold = useCommentOnHold(from);
  const register = (part: "item" | "box", key: string, element: unknown) => {
    // On the web an element's ref is its DOM node; elsewhere it is never looked into.
    if (element === null) parts.current[part].delete(key);
    else parts.current[part].set(key, element as Node);
  };
  return {
    prose,
    text: release === null ? null : { from, register, hold },
    selected: highlight === null ? null : { text: highlight.text, item: itemOf(highlight.end) },
  };
}

/** What a paragraph or bullet `item` of a card's text needs: its element's ref, its long press, and the box that opens under it. */
function useItem(item: Item | undefined, colors: Colors) {
  const card = useContext(CardTextContext);
  if (card === null || item === undefined) return { ref: undefined, onLongPress: undefined, box: null };
  const { hold } = card;
  return {
    ref: (element: unknown) => card.register("item", item.key, element),
    onLongPress: hold === null ? undefined : () => hold({ text: item.text, item: item.key }),
    box: <ItemCommentBox from={card.from} item={item.key} colors={colors} boxRef={(element) => card.register("box", item.key, element)} />,
  };
}

function Body({
  colors,
  muted,
  color,
  item,
  children,
}: {
  colors: Colors;
  muted?: boolean;
  color?: string;
  item?: Item;
  children: React.ReactNode;
}) {
  const { ref, onLongPress, box } = useItem(item, colors);
  return (
    <>
      <Text
        ref={ref}
        selectable={HIGHLIGHTS_TEXT}
        onLongPress={onLongPress}
        style={{ color: color ?? (muted ? colors.foregroundMuted : colors.foreground), fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}
      >
        {children}
      </Text>
      {box}
    </>
  );
}

/** A `sub` is a muted point nested under the bullet, part of the same item. */
function Bullet({ colors, item, sub, children }: { colors: Colors; item?: Item; sub?: React.ReactNode; children: React.ReactNode }) {
  const { ref, onLongPress, box } = useItem(item, colors);
  return (
    <>
      <View ref={ref} style={{ flexDirection: "row", gap: spacing[2] }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>•</Text>
        <View style={{ flex: 1, gap: spacing[1] }}>
          <Text
            selectable={HIGHLIGHTS_TEXT}
            onLongPress={onLongPress}
            style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}
          >
            {children}
          </Text>
          {sub === undefined ? null : (
            <View style={{ flexDirection: "row", gap: spacing[2] }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>◦</Text>
              <Text
                selectable={HIGHLIGHTS_TEXT}
                onLongPress={onLongPress}
                style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}
              >
                {sub}
              </Text>
            </View>
          )}
        </View>
      </View>
      {box}
    </>
  );
}

export function Link({ colors, label, onPress }: { colors: Colors; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link">
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}

