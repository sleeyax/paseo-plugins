import type { PluginTheme } from "@getpaseo/plugin";
import React, { createContext, useContext, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import type { CommentOrigin } from "../shared/drafts.ts";
import { coveredPaths, type Guide, type GuideDecision, type GuideState, type LayeredGuide, type LayeredNode } from "../shared/guide.ts";
import { AskAction, type AskControl } from "./ask-action.tsx";
import { NodeCode } from "./diff-view.tsx";
import { ItemCommentBox, NodeComments, OverviewComments, useCommentOnHold, useCommentOnRelease, type Selected } from "./drafts.tsx";
import { ProgressContext, ProgressSummary, UnderstoodToggle, type ProgressControl } from "./progress.tsx";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";
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
  /** The reviewer's progress and the "understood" toggles; the ready guide draws neither without it. */
  progress?: ProgressControl;
};

/** The guide under the header: its generation while it runs, its failure with a retry, or the guide itself. */
export function GuideView({ reviewId, state, theme, openAgent, retry, ask, progress }: GuideViewProps) {
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
        <ProgressContext.Provider value={progress ?? null}>
          <Overview guide={state.guide} colors={colors} />
          {agentLink ? <View style={{ alignItems: "flex-start" }}>{agentLink}</View> : null}
          <Tree reviewId={reviewId} agentId={state.agentId} guide={state.guide} theme={theme} ask={ask} />
        </ProgressContext.Provider>
      );
  }
}

/** The nodes by layer, trunk first, then Supporting and Unsorted. */
function Tree({
  reviewId,
  agentId,
  guide,
  theme,
  ask,
}: {
  reviewId: string;
  agentId: string;
  guide: LayeredGuide;
  theme: PluginTheme;
  ask: AskControl;
}) {
  const colors = theme.colors;
  const fileCode = (file: string) => <NodeCode reviewId={reviewId} agentId={agentId} subject={{ kind: "file", path: file }} theme={theme} />;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  const layers: LayeredNode[][] = [];
  for (const node of guide.nodes) (layers[node.layer] ??= []).push(node);
  return (
    <>
      <ProgressSummary colors={colors} layerTitle={layerTitle} />
      {/* A node's layer is one past a node's it builds on, so no layer is empty. */}
      {layers.map((nodes, layer) => (
        <React.Fragment key={layer}>
          <Heading colors={colors}>{layerTitle(layer)}</Heading>
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              titles={titles}
              colors={colors}
              ask={ask}
              code={<NodeCode reviewId={reviewId} agentId={agentId} subject={{ kind: "node", nodeId: node.id }} theme={theme} />}
            />
          ))}
        </React.Fragment>
      ))}
      {guide.supporting.length > 0 ? (
        <>
          <Heading colors={colors}>Supporting</Heading>
          <Card colors={colors} light>
            {guide.supporting.map((entry) => (
              <FileEntry
                key={entry.path}
                colors={colors}
                path={entry.path}
                note={entry.category}
                ask={ask}
                folded={entry.category === "lockfile" || entry.category === "generated"}
                code={fileCode(entry.path)}
              />
            ))}
          </Card>
        </>
      ) : null}
      {guide.unsorted.length > 0 ? (
        <>
          <Heading colors={colors}>Unsorted</Heading>
          <Card colors={colors}>
            <Body colors={colors} muted>
              The guide agent placed these changes nowhere, so no concept explains them. Where a concept covers part of a file, only the rest is here.
            </Body>
            {guide.unsorted.map((file) => (
              <FileEntry key={file} colors={colors} path={file} ask={ask} code={fileCode(file)} />
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

function layerTitle(layer: number): string {
  return layer === 0 ? "Foundations" : `Layer ${layer + 1}`;
}

/** The overview, whose text the reviewer can highlight, or hold in the phone app, to comment on. */
function Overview({ guide, colors }: { guide: Guide; colors: Colors }) {
  const { overview } = guide;
  const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
  const { prose, text, selected } = useCardText({ kind: "overview" });
  return (
    <Card colors={colors}>
      <CardTextContext.Provider value={text}>
        <View ref={prose} style={{ gap: spacing[2] }}>
          <Label colors={colors}>The idea</Label>
          <Body colors={colors} item={{ key: "idea", text: overview.idea }}>
            {overview.idea}
          </Body>
          {overview.needToKnows.length > 0 ? (
            <>
              <Label colors={colors}>Need to know</Label>
              {overview.needToKnows.map((item, index) => (
                <Bullet key={index} colors={colors} item={{ key: `need:${index}`, text: item }}>
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
          {overview.attention.map((entry, index) => {
            const title = titles.get(entry.nodeId) ?? entry.nodeId;
            return (
              <Bullet key={index} colors={colors} item={{ key: `attention:${index}`, text: `${title}: ${entry.reason}` }}>
                <Text style={{ fontWeight: "600" }}>{title}</Text>: {entry.reason}
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
 * A node; a leaf, which follows what the trunk already explained, is drawn lighter. Its code (`code`)
 * comes last. The reviewer can highlight its text, not its code, or hold it in the phone app, to comment on.
 */
function NodeCard({
  node,
  titles,
  colors,
  ask,
  code,
}: {
  node: LayeredNode;
  titles: ReadonlyMap<string, string>;
  colors: Colors;
  ask: AskControl;
  code: React.ReactNode;
}) {
  const files = coveredPaths(node);
  const { prose, text, selected } = useCardText({ kind: "node", nodeId: node.id });
  return (
    <Card colors={colors} light={node.leaf}>
      <CardTextContext.Provider value={text}>
        <View ref={prose} style={{ gap: spacing[2] }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[2] }}>
            <Text
              selectable={HIGHLIGHTS_TEXT}
              style={{
                flex: 1,
                color: node.leaf ? colors.foregroundMuted : colors.foreground,
                fontSize: fontSize.base,
                lineHeight: leading(fontSize.base),
                fontWeight: node.leaf ? "500" : "600",
              }}
            >
              {node.title}
            </Text>
            <UnderstoodToggle subject={{ kind: "node", nodeId: node.id }} colors={colors} />
          </View>
          <Body colors={colors} muted item={{ key: "summary", text: node.summary }}>
            {node.summary}
          </Body>
          {node.dependencies.length > 0 ? (
            <>
              <Label colors={colors}>Builds on</Label>
              {node.dependencies.map((dependency) => {
                const title = titles.get(dependency.nodeId) ?? dependency.nodeId;
                return (
                  <Bullet key={dependency.nodeId} colors={colors} item={{ key: `dependency:${dependency.nodeId}`, text: `${title}: ${dependency.reason}` }}>
                    <Text style={{ fontWeight: "600" }}>{title}</Text>: {dependency.reason}
                  </Bullet>
                );
              })}
            </>
          ) : null}
          <Body colors={colors} item={{ key: "explanation", text: node.explanation }}>
            {node.explanation}
          </Body>
          {node.decisions.length > 0 ? <Decisions decisions={node.decisions} colors={colors} /> : null}
        </View>
      </CardTextContext.Provider>
      {files.length > 0 ? (
        <>
          <Label colors={colors}>Files</Label>
          {files.map((file) => (
            <FileLine key={file} colors={colors} path={file} />
          ))}
        </>
      ) : null}
      <AskAction subject={{ kind: "node", nodeId: node.id }} ask={ask} colors={colors} />
      <NodeComments nodeId={node.id} colors={colors} selected={selected} />
      {code}
    </Card>
  );
}

/**
 * A Supporting or Unsorted file, which the reviewer can ask about and mark understood on its own and
 * read the diff of, since tests and wiring get review comments too: the whole of it, or the rest of a
 * file some nodes cover part of. A `folded` entry, a
 * lockfile or a generated file, starts with its diff hidden, as it is long and seldom read.
 */
function FileEntry({
  colors,
  path,
  note,
  ask,
  code,
  folded,
}: {
  colors: Colors;
  path: string;
  note?: string;
  ask: AskControl;
  code: React.ReactNode;
  folded?: boolean;
}) {
  const [open, setOpen] = React.useState(!folded);
  return (
    <View style={{ gap: spacing[1] }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[2] }}>
        <View style={{ flex: 1 }}>
          <FileLine colors={colors} path={path} note={note} />
        </View>
        <UnderstoodToggle subject={{ kind: "file", path }} colors={colors} />
      </View>
      <AskAction subject={{ kind: "file", path }} ask={ask} colors={colors} />
      <View style={{ alignItems: "flex-start" }}>
        <Link colors={colors} label={open ? "Hide the diff" : "Show the diff"} onPress={() => setOpen(!open)} />
      </View>
      {open ? code : null}
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
      {decisions.map((decision, index) => (
        <Bullet key={index} colors={colors} item={{ key: `decision:${index}`, text: `${decision.choice} Rather than: ${decision.rejected}` }}>
          {decision.choice}
          <Text style={{ color: colors.foregroundMuted }}> Rather than: {decision.rejected}</Text>
        </Bullet>
      ))}
    </>
  );
}

/** A `light` card sits on the panel's own background rather than raised on a card surface. */
function Card({ colors, light, children }: { colors: Colors; light?: boolean; children: React.ReactNode }) {
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
 * records each paragraph's and bullet's element so a highlight can be traced to the one it ends
 * in. `hold` comments on a whole one, which the phone app offers on a long press; null on the web.
 */
type CardText = { from: CommentOrigin; register: (key: string, element: unknown) => void; hold: ((held: Selected) => void) | null };

/** Null outside a card whose text takes comments, and outside a review. */
const CardTextContext = createContext<CardText | null>(null);

/**
 * What a card of `from` needs for comments on its text: the element of its prose, which a highlight
 * has to lie inside, the `CardText` its paragraphs and bullets read, and what is highlighted in it.
 */
function useCardText(from: CommentOrigin): { prose: React.RefObject<View | null>; text: CardText | null; selected: Selected | null } {
  const prose = useRef<View>(null);
  const items = useRef(new Map<string, Node>());
  const itemOf = (end: Node) => [...items.current].find(([, element]) => element.contains(end))?.[0];
  const release = useCommentOnRelease(from);
  const highlight = useHighlight(prose, release && ((found) => release({ text: found.text, item: itemOf(found.end) })));
  const hold = useCommentOnHold(from);
  const register = (key: string, element: unknown) => {
    // On the web an element's ref is its DOM node; elsewhere it is never looked into.
    if (element === null) items.current.delete(key);
    else items.current.set(key, element as Node);
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
    ref: (element: unknown) => card.register(item.key, element),
    onLongPress: hold === null ? undefined : () => hold({ text: item.text, item: item.key }),
    box: <ItemCommentBox from={card.from} item={item.key} colors={colors} />,
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

function Bullet({ colors, item, children }: { colors: Colors; item?: Item; children: React.ReactNode }) {
  const { ref, onLongPress, box } = useItem(item, colors);
  return (
    <>
      <View ref={ref} style={{ flexDirection: "row", gap: spacing[2] }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>•</Text>
        <Text
          selectable={HIGHLIGHTS_TEXT}
          onLongPress={onLongPress}
          style={{ flex: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}
        >
          {children}
        </Text>
      </View>
      {box}
    </>
  );
}

function Link({ colors, label, onPress }: { colors: Colors; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link">
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}

