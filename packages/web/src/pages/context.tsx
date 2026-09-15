import type {
  ContextDecisionEffect,
  ContextTreeChangeType,
  ContextTreeInfluenceEvent,
  ContextTreeIoEvent,
  ContextTreeNode,
  ContextTreeSnapshot,
  ContextTreeWriteEvent,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { stratify, tree } from "d3-hierarchy";
import { AlertTriangle, Info, Network, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { getContextTreeSnapshot } from "../api/context-tree.js";
import { useAuth } from "../auth/auth-context.js";
import { resolveAvatarHue } from "../components/chat/chat-row-avatar.js";
import { Identicon } from "../components/identicon.js";
import { Button } from "../components/ui/button.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Panel, PanelBody } from "../components/ui/panel.js";
import { useGitlabEntityPresentation } from "../hooks/use-gitlab-entity-presentation.js";
import { contextTreeSourceHref } from "../lib/context-source-link.js";
import {
  GITLAB_WEB_CONTEXT_UNAVAILABLE_DETAIL,
  GITLAB_WEB_CONTEXT_UNAVAILABLE_TITLE,
  isTeamNonActionableGitlabWebContext,
} from "./context-tree-availability.js";
import { ContextSectionTabs } from "./docs/context-section-tabs.js";

const CONTEXT_WINDOW = "7d";
// Live-feed refetch cadence. The usage feed inside the snapshot is what wants
// to feel "live" — admins glancing at the page should see timestamps tick and
// new sessions arrive. 20s = 3 req/min sits comfortably under the 6/min rate
// limit even with two Context Tabs open simultaneously (4/min combined).
const CONTEXT_REFETCH_MS = 20_000;

export function ContextPage({ previewSnapshot }: { previewSnapshot?: ContextTreeSnapshot } = {}) {
  const { organizationId, role } = useAuth();
  const [selectedUpdateId, setSelectedUpdateId] = useState<string | null>(null);
  const preview = previewSnapshot !== undefined;
  const isAdmin = role === "admin";

  const query = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, CONTEXT_WINDOW, preview],
    queryFn: () => {
      if (!organizationId) throw new Error("No organization selected");
      return getContextTreeSnapshot(organizationId, CONTEXT_WINDOW);
    },
    enabled: !preview && !!organizationId,
    refetchInterval: preview ? false : CONTEXT_REFETCH_MS,
    refetchIntervalInBackground: false,
  });

  const snapshot = previewSnapshot ?? query.data;
  const selectedUpdate = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.updates.find((update) => update.id === selectedUpdateId) ?? snapshot.updates[0] ?? null;
  }, [selectedUpdateId, snapshot]);
  const selectedNodeId = selectedUpdate?.nodeId ?? null;

  useEffect(() => {
    if (!snapshot) return;
    if (selectedUpdateId && snapshot.updates.some((update) => update.id === selectedUpdateId)) return;
    setSelectedUpdateId(snapshot.updates[0]?.id ?? null);
  }, [selectedUpdateId, snapshot]);

  const liveStatusReady = snapshot && (preview || !query.isLoading) && snapshot.snapshotStatus !== "unavailable";

  return (
    <>
      <PageHeader
        title="Context"
        subtitle="Your team's Context Tree."
        right={liveStatusReady ? <LiveStatus snapshot={snapshot} /> : null}
      />
      {!preview && <ContextSectionTabs active="tree" />}
      <div className="context-live-page">
        {!preview && query.isLoading ? <LoadingState /> : null}
        {!preview && query.error ? (
          <ErrorState message={query.error instanceof Error ? query.error.message : "Failed to load"} />
        ) : null}
        {snapshot && (preview || !query.isLoading) ? (
          snapshot.snapshotStatus === "unavailable" ? (
            <UnavailableState snapshot={snapshot} isAdmin={isAdmin} canManageSettings={!preview && isAdmin} />
          ) : (
            <>
              <ContextStatusNote snapshot={snapshot} />
              <ChangeMap
                snapshot={snapshot}
                selectedNodeId={selectedNodeId}
                onSelectNode={(nodeId) => {
                  const matchingUpdate = snapshot.updates.find((update) => update.nodeId === nodeId);
                  setSelectedUpdateId(matchingUpdate?.id ?? null);
                }}
              />
              <ContextSignal snapshot={snapshot} />
              <ContextInfluence snapshot={snapshot} />
              <ContextUsageFeed snapshot={snapshot} />
            </>
          )
        ) : null}
      </div>
    </>
  );
}

/**
 * Live-sync chip for the page header's right slot. A severity-toned dot pulses
 * with a glow (DESIGN: green = the living system, working-form = pulse + glow),
 * next to a "LIVE" eyebrow and the exact last-synced time. The always-present
 * liveness signal in dense, left-of-the-page-edge chrome — no marketing hero.
 */
function LiveStatus({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const lastUpdated = exactTimeLabel(snapshot.syncedAt);
  const statusTone = severityColor(snapshot.contextStatus.severity);
  return (
    <span className="context-live-status" title={snapshot.contextStatus.label}>
      <span
        aria-hidden="true"
        className="context-live-dot"
        style={{ background: statusTone, ["--context-live-dot-color" as string]: statusTone }}
      />
      <span className="text-eyebrow context-live-label" style={{ color: statusTone }}>
        LIVE
      </span>
      {lastUpdated ? <span className="text-label context-live-time">· synced {lastUpdated}</span> : null}
    </span>
  );
}

/** Inline notice shown only when the tree sync is not healthy (warning/danger);
 *  the ok path stays chrome-free per the read-only / informational rule. */
function ContextStatusNote({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  if (snapshot.contextStatus.severity === "ok") return null;
  const detail = snapshot.contextStatus.detail ?? snapshot.contextStatus.label;
  const tone = severityColor(snapshot.contextStatus.severity);
  return (
    <div className="flex items-center text-label" style={{ gap: "var(--sp-2)", color: tone }}>
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{detail}</span>
    </div>
  );
}

function ChangeMap({
  snapshot,
  selectedNodeId,
  onSelectNode,
}: {
  snapshot: ContextTreeSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const groups = useMemo(() => changeGroups(snapshot.nodes), [snapshot.nodes]);
  const selectedGroupId = useMemo(
    () => selectedChangeGroupId(snapshot.nodes, selectedNodeId),
    [snapshot.nodes, selectedNodeId],
  );
  const placedGroups = useMemo(() => placeChangeGroups(groups, selectedGroupId), [groups, selectedGroupId]);
  const summaryUpdateCount = Math.max(snapshot.summary.changedNodeCount, snapshot.updates.length);

  return (
    <section className="context-map-section" aria-label="Context Tree update change map">
      <div className="text-label context-map-kicker">Past 7 days · Top updated domains</div>
      <div className="context-map-frame">
        {placedGroups.length === 0 ? (
          <EmptyChanges />
        ) : (
          <svg
            viewBox="0 0 920 420"
            role="img"
            aria-label="Recent Context Tree update branches"
            preserveAspectRatio="xMidYMid meet"
            className="context-network-svg"
          >
            <title>Update Change Map</title>
            <circle className="context-network-live-halo" cx="460" cy="210" r="104" />
            {placedGroups.map((group) => (
              <path
                key={`path:${group.id}`}
                d={connectionPath(group)}
                fill="none"
                stroke={group.selected ? "var(--success)" : "var(--border-strong)"}
                strokeDasharray="5 8"
                strokeLinecap="round"
                strokeOpacity={group.selected ? 0.7 : 0.36}
                strokeWidth={group.selected ? 2 : 1.4}
              />
            ))}
            <foreignObject x="338" y="122" width="244" height="176" className="context-network-card-wrap">
              <div className="context-network-summary-card">
                <span className="context-network-summary-icon" aria-hidden="true">
                  <Network size={30} strokeWidth={2.3} />
                </span>
                <span className="text-eyebrow context-network-summary-title">Context Tree</span>
                <span className="text-title context-network-summary-scale">
                  {formatNumber(snapshot.nodes.length)}
                  <span className="text-caption context-network-summary-unit">total nodes</span>
                </span>
                <span className="text-caption font-semibold context-network-summary-badge">
                  +{formatNumber(summaryUpdateCount)} updates
                </span>
              </div>
            </foreignObject>
            {placedGroups.map((group) => (
              <foreignObject
                key={group.id}
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                className="context-network-card-wrap"
              >
                <button
                  type="button"
                  className={group.selected ? "context-network-card is-live" : "context-network-card"}
                  onClick={() => onSelectNode(group.representativeNodeId)}
                >
                  <span className="context-network-pin" aria-hidden="true" />
                  <span className="text-subtitle context-network-title">{group.title}</span>
                  <span className="context-change-breakdown">
                    {changeBreakdownParts(group.changeCounts).map((part) => (
                      <span key={part.type} data-change-type={part.type}>
                        {formatNumber(part.count)} {part.label}
                      </span>
                    ))}
                  </span>
                </button>
              </foreignObject>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}

function ContextSignal({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const windowText = snapshot.io.windowDays === 1 ? "1 day" : `${snapshot.io.windowDays} days`;
  const readAgentText =
    snapshot.io.summary.read.agentCount === 1 ? "1 agent" : `${snapshot.io.summary.read.agentCount} agents`;
  const writeAgentText =
    snapshot.io.summary.write.agentCount === 1 ? "1 agent" : `${snapshot.io.summary.write.agentCount} agents`;
  const readTimesText =
    snapshot.io.summary.read.eventCount === 1 ? "1 time" : `${snapshot.io.summary.read.eventCount} times`;
  const writeTimesText =
    snapshot.io.summary.write.eventCount === 1 ? "1 time" : `${snapshot.io.summary.write.eventCount} times`;

  if (snapshot.io.summary.read.eventCount === 0 && snapshot.io.summary.write.eventCount === 0) {
    return (
      <div className="text-body context-signal" style={{ color: "var(--fg-3)" }}>
        <span>No Context Tree reads or writes in the past {windowText}.</span>
      </div>
    );
  }

  return (
    <div className="text-body context-signal" style={{ color: "var(--fg-3)" }}>
      <span>
        In the past {windowText}, <mark>{readAgentText}</mark> read the tree <mark>{readTimesText}</mark>
      </span>
      <span>
        and <mark>{writeAgentText}</mark> wrote <mark>{writeTimesText}</mark>.
      </span>
    </div>
  );
}

const INFLUENCE_EFFECT_LABELS: Record<ContextDecisionEffect, string> = {
  conflicted: "Conflict surfaced",
  redirected: "Approach changed",
  constrained: "Options narrowed",
  confirmed: "Direction supported",
};

/**
 * What agents REPORT the tree changed, as opposed to how often it was opened.
 *
 * Every number here is agent-reported, and the copy has to keep saying so. The
 * Server proves only that an agent authored a convertible impact note citing an
 * exact commit; it does not verify that the passage caused the choice, and the
 * per-message receipt card that used to carry that disclosure is gone. So the
 * eyebrow, the headline, and the ranked list all read as attribution rather
 * than as a platform-verified fact.
 *
 * Placed directly under the read/write signal on purpose: the two numbers only
 * mean something next to each other. A node can be opened on every navigation
 * and never change an outcome, so the ranked list is the signal a gardener
 * needs — but a node absent from it is an incomplete signal, never a verdict
 * that the node has no value: coverage is partial in three separate ways, which
 * is what the caveat below spells out.
 *
 * No percentage and no effect-distribution chart yet. The read count includes
 * navigation opens that the authoring contract explicitly excludes from
 * influence, so a ratio of the two would read as a conversion rate while
 * measuring two different things. Conflicts are called out on their own because
 * they stay meaningful at any volume: they are the case where the tree caught
 * something before it shipped.
 */
function ContextInfluence({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const { organizationId } = useAuth();
  // A GitLab-hosted tree only resolves to a web URL against the Team's own
  // connected origin; without it every node here would render as inert text and
  // the "inspectable source" promise would hold on GitHub teams only.
  const { instanceOrigin, gitlabVersion } = useGitlabEntityPresentation(organizationId ?? null);
  // The ranking deliberately carries no title: a citation's label is the
  // agent's own wording inside a chat the viewer may not be in. Resolve the
  // display name from the org-visible tree snapshot instead, falling back to
  // the file name when the node is not in the current snapshot (it may have
  // been renamed or removed since the decision was made).
  const nodeTitleByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    // Normalize both sides: snapshot node paths are tree-root-relative but a
    // leading slash appears in some producers, and a citation always names the
    // file while a node may be keyed by its directory path.
    const key = (value: string) => value.replace(/^\/+/, "");
    for (const node of snapshot.nodes) {
      if (node.sourcePath) byPath.set(key(node.sourcePath), node.title);
      byPath.set(key(node.path), node.title);
      byPath.set(`${key(node.path)}.md`, node.title);
    }
    return byPath;
  }, [snapshot.nodes]);
  const influence = snapshot.influence;
  // A Server too old to report influence is NOT the same as a window with none.
  // Rendering a confident "0 decisions" for the first case would invent an
  // answer the Server never gave.
  if (!influence) return null;
  const { decisionCount, effects, nodes, truncated } = influence;

  return (
    <section className="context-influence" aria-label="Context Tree influence reported by agents">
      <div className="context-influence-eyebrow">Agent-reported</div>
      <div className="context-influence-header">
        <span className="context-influence-count">
          {/* A truncated window makes every count a floor, so the number must
              not be presented as the answer. */}
          {truncated ? `${decisionCount}+` : decisionCount}
        </span>
        <span className="context-influence-label">
          {decisionCount === 1 ? "decision reported as shaped" : "decisions reported as shaped"}
          {effects.conflicted > 0 ? (
            <span className="context-influence-conflict">
              {effects.conflicted === 1 ? "1 surfaced a conflict" : `${effects.conflicted} surfaced a conflict`}
            </span>
          ) : null}
        </span>
      </div>
      {truncated ? (
        <p className="context-influence-partial">
          This window holds more candidate receipts than one pass reads, so these counts are a floor and the ranking may
          be incomplete.
        </p>
      ) : null}
      {nodes.length > 0 ? (
        <>
          <div className="context-influence-nodes-title">Nodes agents cited as changing a decision</div>
          <ul className="context-influence-nodes">
            {nodes.map((node) => {
              // Link identity comes from the SNAPSHOT, never from the note: the
              // repository and commit a citation names are asserted inside a
              // chat the viewer may not be in, and nothing verifies them. The
              // Server already dropped any node this snapshot does not carry,
              // so the path here is org-visible by construction.
              const href =
                snapshot.repo && snapshot.headCommit
                  ? contextTreeSourceHref(
                      { repoUrl: snapshot.repo, commit: snapshot.headCommit, nodePath: node.nodePath },
                      instanceOrigin,
                      gitlabVersion,
                    )
                  : null;
              const title = nodeTitleByPath.get(node.nodePath) ?? nodeFileName(node.nodePath);
              return (
                <li key={node.nodePath} className="context-influence-node">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" title={node.nodePath}>
                      {title}
                    </a>
                  ) : (
                    <span title={node.nodePath}>{title}</span>
                  )}
                  <span className="context-influence-node-path">{node.nodePath}</span>
                  <span className="context-influence-node-count">{node.decisionCount}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {/* Three separate coverage gaps, each of which makes this an undercount:
          a BYO session prints its note in the user's own terminal and never
          reaches the Server; only English and Chinese notes can be read back;
          and nothing before this feature shipped was recorded. Stating all
          three is what stops a low number from reading as a verdict on the
          tree — or on a node missing from the list above. */}
      <p className="context-influence-coverage">
        Reported by agents in their own answers — First Tree preserves the cited version for inspection, but does not
        verify causality. Counted from managed chats only, and only from notes this Server could read back, so treat a
        low count as incomplete rather than as a verdict.
      </p>
    </section>
  );
}

// Initial rows shown before "Show all". 20 (not 10) because the feed defaults
// to All, where the ~13:1 read:write volume means a 10-row window is almost
// entirely reads; 20 rows reliably surfaces recent writes without forcing the
// Writes filter. The full list (reads ≤50 + writes ≤200) is one click away.
const CONTEXT_USAGE_FEED_DEFAULT_LIMIT = 20;
// Re-render every 30s so "Xm ago" labels tick without a fresh server roundtrip.
// Pairs with the 20s snapshot refetch above — together they keep the feed
// feeling like a live stream even when no new events arrive.
const CONTEXT_USAGE_TIME_TICK_MS = 30_000;
// CSS animation duration on .fresh — keep this in sync with index.css so the
// className is removed exactly when the flash finishes (no lingering tint when
// React re-renders for an unrelated reason).
const CONTEXT_USAGE_FRESH_MS = 1_200;

// The feed is one chronological agent-action stream: telemetry reads
// (best-effort, live) interleaved with git-derived writes (complete, including
// PR merges, reconciled to an agent when possible). A [All / Reads / Writes]
// filter lets a viewer isolate writes — without it the ~13:1 read:write volume
// would bury writes in the most-recent rows (the bug issue 1071 fixes).
type ContextFeedFilter = "all" | "influence" | "reads" | "writes";

type ContextFeedItem =
  | { kind: "read"; id: string; timeMs: number; read: ContextTreeIoEvent }
  | { kind: "write"; id: string; timeMs: number; write: ContextTreeWriteEvent }
  | { kind: "influence"; id: string; timeMs: number; influence: ContextTreeInfluenceEvent };

const CONTEXT_FEED_FILTERS: ReadonlyArray<{ key: ContextFeedFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "influence", label: "Influence" },
  { key: "writes", label: "Writes" },
  { key: "reads", label: "Reads" },
];

/** Last path segment — the fallback display name for a node the snapshot no longer carries. */
function nodeFileName(nodePath: string): string {
  return nodePath.split("/").filter(Boolean).at(-1) ?? nodePath;
}

function feedTimeMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildContextFeedItems(snapshot: ContextTreeSnapshot): ContextFeedItem[] {
  const reads: ContextFeedItem[] = snapshot.io.recentEvents.map((read) => ({
    kind: "read",
    id: `read:${read.id}`,
    timeMs: feedTimeMs(read.createdAt),
    read,
  }));
  const writes: ContextFeedItem[] = snapshot.io.writes.map((write) => ({
    kind: "write",
    id: `write:${write.id}`,
    timeMs: feedTimeMs(write.createdAt),
    write,
  }));
  // An influenced message is also a read, but the read row says only "opened
  // this file" while the influence row says what changed. Both stay in the
  // stream; the filter is what lets a viewer isolate the second kind.
  const influences: ContextFeedItem[] = (snapshot.influence?.recentEvents ?? []).map((influence) => ({
    kind: "influence",
    id: `influence:${influence.id}`,
    timeMs: feedTimeMs(influence.createdAt),
    influence,
  }));
  return [...influences, ...writes, ...reads].sort((a, b) => b.timeMs - a.timeMs);
}

// Build a `…/pull/N` link from the bound context-tree repo, accepting both a
// full git URL (`https://github.com/org/repo.git`, `git@github.com:org/repo`)
// and a bare `org/repo` slug. Returns null when the repo can't be parsed, so
// the PR still renders as inert `#N` text rather than a broken link.
function githubPrUrl(repo: string | null, prNumber: number): string | null {
  if (!repo) return null;
  const slug =
    repo.match(/github\.com[/:]+([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1] ??
    repo.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
  return slug ? `https://github.com/${slug}/pull/${prNumber}` : null;
}

function ContextUsageFeed({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ContextFeedFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  // Tracks the previous item-id set across renders so we can diff for
  // arrivals on each snapshot refresh without re-flashing on every render.
  const seenIdsRef = useRef<Set<string>>(new Set());

  const items = useMemo(() => buildContextFeedItems(snapshot), [snapshot]);
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (filter === "all") return true;
        if (filter === "influence") return item.kind === "influence";
        if (filter === "writes") return item.kind === "write";
        return item.kind === "read";
      }),
    [items, filter],
  );

  // Tick the displayed `Xm ago` labels every 30s. Cheap — only forces a
  // re-render of this subtree.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), CONTEXT_USAGE_TIME_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // On every snapshot change, diff against the previously-seen item ids.
  // Anything new gets the `fresh` className for one animation cycle, then is
  // removed so a later unrelated re-render does not retrigger the flash.
  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    const seen = seenIdsRef.current;
    const newlyArrived = new Set<string>();
    for (const id of currentIds) {
      if (!seen.has(id)) newlyArrived.add(id);
    }
    seenIdsRef.current = currentIds;
    // First mount has no "fresh" — every item is just history. Only after
    // the seen set has been populated once do new ids count as arrivals.
    if (seen.size === 0 || newlyArrived.size === 0) return;
    setFreshIds((prev) => {
      const next = new Set(prev);
      for (const id of newlyArrived) next.add(id);
      return next;
    });
    const handle = setTimeout(() => {
      setFreshIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of newlyArrived) next.delete(id);
        return next;
      });
    }, CONTEXT_USAGE_FRESH_MS);
    return () => clearTimeout(handle);
  }, [items]);

  if (items.length === 0) return null;

  const visible = showAll ? filtered : filtered.slice(0, CONTEXT_USAGE_FEED_DEFAULT_LIMIT);
  const remaining = filtered.length - visible.length;

  return (
    <section className="context-usage-feed" aria-label="Recent Context Tree agent activity">
      <div className="context-usage-feed-header">
        <span className="context-usage-feed-live-dot" aria-hidden="true" />
        <span className="context-usage-feed-live-label">LIVE</span>
        <span className="context-usage-feed-live-sublabel">· agent activity on the tree</span>
        <fieldset className="context-usage-feed-filter" aria-label="Filter agent activity">
          {CONTEXT_FEED_FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={
                filter === option.key ? "context-usage-feed-filter-btn is-active" : "context-usage-feed-filter-btn"
              }
              aria-pressed={filter === option.key}
              onClick={() => {
                setFilter(option.key);
                setShowAll(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <ul className="context-usage-feed-list">
        {visible.map((item) => {
          if (item.kind === "write") {
            return (
              <WriteFeedRow
                key={item.id}
                write={item.write}
                now={now}
                fresh={freshIds.has(item.id)}
                repo={snapshot.repo}
              />
            );
          }
          if (item.kind === "influence") {
            return (
              <InfluenceFeedRow
                key={item.id}
                event={item.influence}
                now={now}
                fresh={freshIds.has(item.id)}
                navigate={navigate}
              />
            );
          }
          return (
            <ReadFeedRow key={item.id} event={item.read} now={now} fresh={freshIds.has(item.id)} navigate={navigate} />
          );
        })}
      </ul>
      {remaining > 0 ? (
        <button type="button" className="context-usage-feed-more" onClick={() => setShowAll(true)}>
          Show all {filtered.length} ›
        </button>
      ) : null}
    </section>
  );
}

function ReadFeedRow({
  event,
  now,
  fresh,
  navigate,
}: {
  event: ContextTreeIoEvent;
  now: number;
  fresh: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // Pin chatId to a local const so the truthiness narrow survives into the
  // onClick closure — `event.chatId` is `string | null`.
  const chatId = event.chatId;
  const hue = resolveAvatarHue(event.agentAvatarColorToken, event.agentId);
  return (
    <li className={fresh ? "context-usage-feed-row is-fresh" : "context-usage-feed-row"}>
      <span className="context-usage-feed-dot" aria-hidden="true" />
      <Identicon seed={event.agentId} size={22} color={hue} className="context-usage-feed-avatar" />
      <span className="context-usage-feed-text">
        <span className="context-usage-feed-agent">{event.agentName}</span>
        <span className="context-usage-feed-action"> read </span>
        {event.targetPath !== "/" ? (
          <span className="context-usage-feed-node" title={event.targetPath}>
            {event.targetPath}
          </span>
        ) : (
          <span className="context-usage-feed-action">the Context Tree</span>
        )}
        {chatId ? (
          <>
            <span className="context-usage-feed-action"> in </span>
            {event.viewerCanAccess ? (
              <button
                type="button"
                className="context-usage-feed-chat"
                onClick={() => navigate(`/?c=${encodeURIComponent(chatId)}`)}
              >
                {chatLabel(event)}
              </button>
            ) : (
              // Org-wide the label is visible, but a non-member must not be able
              // to navigate into a chat the server would 404 — render inert text
              // instead of a link. See summarizeContextTreeUsage / viewerCanAccess.
              <span className="context-usage-feed-chat is-static" title="No access to this chat">
                {chatLabel(event)}
              </span>
            )}
          </>
        ) : null}
      </span>
      <span className="context-usage-feed-time">{relativeTimeLabel(event.createdAt, now)}</span>
    </li>
  );
}

/**
 * One decision the tree changed. Unlike a read row ("opened this file") this
 * row carries the outcome — the effect label plus the agent's own sentence —
 * and links into the chat where the decision was made, for a viewer allowed to
 * open it. `conflicted` is the one effect toned differently: it means the tree
 * caught two rules that cannot both hold, which is unresolved work, not a win.
 */
function InfluenceFeedRow({
  event,
  now,
  fresh,
  navigate,
}: {
  event: ContextTreeInfluenceEvent;
  now: number;
  fresh: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const hue = resolveAvatarHue(event.agentAvatarColorToken, event.agentId);
  const conflict = event.effect === "conflicted";
  const rowClass = ["context-usage-feed-row", "is-influence", conflict ? "is-conflict" : "", fresh ? "is-fresh" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={rowClass}>
      <span className="context-usage-feed-dot" aria-hidden="true" />
      <Identicon seed={event.agentId} size={22} color={hue} className="context-usage-feed-avatar" />
      <span className="context-usage-feed-text">
        <span className="context-usage-feed-agent">{event.agentName}</span>
        <span className="context-usage-feed-action"> applied </span>
        {event.evidence.map((evidence, index) => (
          <span key={`${evidence.commit}:${evidence.nodePath}`}>
            {index > 0 ? <span className="context-usage-feed-action"> · </span> : null}
            <span className="context-usage-feed-node" title={evidence.nodePath}>
              {evidence.heading ?? evidence.nodePath}
            </span>
          </span>
        ))}
        <span className="context-usage-feed-action"> in </span>
        {/* The Server omits decisions from chats this viewer cannot open — the
            summary below is copied from a private message body — so every row
            that reaches here is one they may follow. */}
        <button
          type="button"
          className="context-usage-feed-chat"
          onClick={() => navigate(`/?c=${encodeURIComponent(event.chatId)}`)}
        >
          {chatLabel(event)}
        </button>
        <span className="context-influence-row-outcome">
          <span className="context-influence-row-effect">{INFLUENCE_EFFECT_LABELS[event.effect]}</span>
          <span className="context-usage-feed-summary"> — {event.summary}</span>
        </span>
      </span>
      <span className="context-usage-feed-time">{relativeTimeLabel(event.createdAt, now)}</span>
    </li>
  );
}

function writeVerb(changeType: ContextTreeChangeType): string {
  if (changeType === "added") return " added ";
  if (changeType === "removed") return " removed ";
  return " wrote ";
}

function WriteFeedRow({
  write,
  now,
  fresh,
  repo,
}: {
  write: ContextTreeWriteEvent;
  now: number;
  fresh: boolean;
  repo: string | null;
}) {
  // Reconciled to an agent when telemetry matched; otherwise the git author
  // (a human or a GitHub merge identity) — shown honestly, not faked as an agent.
  const attributed = write.agentId !== null;
  const displayName = write.agentName ?? write.authorName ?? "unknown";
  const hue = attributed ? resolveAvatarHue(write.agentAvatarColorToken, write.agentId ?? displayName) : undefined;
  const prUrl = write.prNumber !== null ? githubPrUrl(repo, write.prNumber) : null;
  const rowClass = ["context-usage-feed-row", "is-write", fresh ? "is-fresh" : ""].filter(Boolean).join(" ");
  return (
    <li className={rowClass}>
      <span className="context-usage-feed-write-icon" aria-hidden="true">
        ✎
      </span>
      {attributed ? (
        <Identicon
          seed={write.agentId ?? displayName}
          size={22}
          color={hue ?? "var(--avatar-hue-0)"}
          className="context-usage-feed-avatar"
        />
      ) : (
        // Git author (no agent matched): keep an honest neutral initials marker,
        // never a generated identicon that would read as a first-tree agent.
        <span className="context-usage-feed-avatar is-git" aria-hidden="true">
          {agentInitials(displayName)}
        </span>
      )}
      <span className="context-usage-feed-text">
        <span className="context-usage-feed-agent">{displayName}</span>
        <span className="context-usage-feed-action">{writeVerb(write.changeType)}</span>
        {write.nodePath ? (
          <span className="context-usage-feed-node" title={write.nodePath}>
            {write.nodePath}
          </span>
        ) : (
          // Root node writes carry an empty node path (the root's tree path is
          // ""); render the same friendly label reads use for the repo root.
          <span className="context-usage-feed-action">the Context Tree</span>
        )}
        {write.summary ? <span className="context-usage-feed-summary"> — {write.summary}</span> : null}
        {write.prNumber !== null ? (
          prUrl ? (
            <a className="context-usage-feed-pr" href={prUrl} target="_blank" rel="noreferrer">
              #{write.prNumber}
            </a>
          ) : (
            <span className="context-usage-feed-pr is-static">#{write.prNumber}</span>
          )
        ) : null}
        {write.riskLevel !== "low" ? (
          <span className={`context-usage-feed-risk is-${write.riskLevel}`}>{write.riskLevel}</span>
        ) : null}
        {!attributed ? (
          <span className="context-usage-feed-unmatched" title="No agent matched — showing the git author">
            git author
          </span>
        ) : null}
      </span>
      <span className="context-usage-feed-time">{write.createdAt ? relativeTimeLabel(write.createdAt, now) : ""}</span>
    </li>
  );
}

/**
 * Two-letter initials for a git author with no matched agent (the only
 * remaining non-identicon avatar — agents use <Identicon>). Handles
 * space/kebab/snake/dot separators ("gandy-coder" → "GC"), falling back to the
 * first two characters for single tokens. Always uppercase.
 */
function agentInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "??";
  const tokens = trimmed.split(/[\s._-]+/).filter((part) => part.length > 0);
  if (tokens.length >= 2) {
    return `${tokens[0]?.[0] ?? ""}${tokens[1]?.[0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function chatLabel(event: { chatTitle: string | null; chatId: string | null }): string {
  const trimmed = event.chatTitle?.trim();
  if (trimmed && trimmed.length > 0) return `#${trimmed}`;
  if (event.chatId) return `#${event.chatId.slice(-6)}`;
  return "";
}

function relativeTimeLabel(value: string, nowMs: number): string {
  const diffMs = nowMs - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function LoadingState() {
  // Cold-load only (no cached snapshot). Center an intentional loading state
  // in the content area with a spinning icon, rather than a single static line
  // pinned to the top-left. `animate-spin` is the same spinner utility used
  // across the app (see save-bar / agent-row).
  return (
    <div
      className="flex flex-col items-center justify-center text-body"
      style={{ color: "var(--fg-2)", gap: "var(--sp-3)", minHeight: "50vh", textAlign: "center" }}
    >
      <RefreshCw size={22} className="animate-spin" aria-hidden="true" />
      <span>Loading team context...</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Panel>
      <PanelBody>
        <div className="flex items-center text-body" style={{ color: "var(--danger)", gap: "var(--sp-2)" }}>
          <AlertTriangle size={17} />
          {message}
        </div>
      </PanelBody>
    </Panel>
  );
}

function UnavailableState({
  snapshot,
  isAdmin,
  canManageSettings,
}: {
  snapshot: ContextTreeSnapshot;
  isAdmin: boolean;
  canManageSettings: boolean;
}) {
  const gitlabContentAvailability =
    snapshot.provider === "gitlab" && snapshot.contentAvailability?.status === "unavailable"
      ? snapshot.contentAvailability
      : null;
  const unavailableGitlabContent = gitlabContentAvailability !== null;
  const gitlabUnavailableReason = gitlabContentAvailability?.reason ?? null;
  const teamNonActionableGitlabWebContext = isTeamNonActionableGitlabWebContext(snapshot);
  const gitlabCopy = teamNonActionableGitlabWebContext
    ? {
        title: GITLAB_WEB_CONTEXT_UNAVAILABLE_TITLE,
        detail: GITLAB_WEB_CONTEXT_UNAVAILABLE_DETAIL,
      }
    : gitlabUnavailableReason
      ? gitlabUnavailableCopy(gitlabUnavailableReason)
      : null;
  const title = snapshot.repo
    ? unavailableGitlabContent
      ? (gitlabCopy?.title ?? "GitLab content is unavailable in Cloud")
      : "Context Tree sync unavailable"
    : isAdmin
      ? "Your team doesn't have a Context Tree yet"
      : "Connect Context Tree";
  const detail = snapshot.repo
    ? unavailableGitlabContent
      ? (gitlabCopy?.detail ??
        "The anonymous GitLab repository refresh failed. Use an Agent with local git/glab access to inspect it; inbound Webhook automation is independent.")
      : isAdmin
        ? "Review the binding and recovery options in Settings."
        : "Ask an admin to inspect this Context Tree sync issue."
    : isAdmin
      ? "Set it up in Settings when your team is ready."
      : "Ask an admin to set up your team's Context Tree.";
  const syncDetail = teamNonActionableGitlabWebContext ? null : snapshot.contextStatus.detail;
  const repoLabel = snapshot.repo ? redactRepoForDisplay(snapshot.repo) : null;
  const AvailabilityIcon = teamNonActionableGitlabWebContext ? Info : AlertTriangle;
  return (
    <Panel>
      <PanelBody>
        <div
          className="flex items-start text-body"
          data-context-availability-tone={teamNonActionableGitlabWebContext ? "neutral" : "warning"}
          style={{ color: "var(--fg-2)", gap: "var(--sp-2)" }}
        >
          <AvailabilityIcon
            aria-hidden
            size={18}
            style={{ color: teamNonActionableGitlabWebContext ? "var(--fg-3)" : "var(--warning)" }}
          />
          <div>
            <div className="font-semibold" style={{ color: "var(--fg)" }}>
              {title}
            </div>
            <div style={{ marginTop: "var(--sp-1)" }}>{detail}</div>
            {syncDetail ? (
              <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
                {syncDetail}
              </div>
            ) : null}
            {/* Context is permanently read-only. Team-actionable binding and
                recovery work belongs to Settings; GitLab auth and
                operator-owned egress failures are not Team setup debt. */}
            {canManageSettings && !teamNonActionableGitlabWebContext ? (
              <div style={{ marginTop: "var(--sp-3)" }}>
                <Button asChild type="button" variant="outline" size="sm">
                  <Link to="/settings/context#binding">
                    {snapshot.repo ? "Manage Context Tree" : "Set up Context Tree"}
                  </Link>
                </Button>
              </div>
            ) : null}
            {snapshot.repo || snapshot.branch ? (
              <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
                {repoLabel ? `Repo: ${repoLabel}` : null}
                {snapshot.repo && snapshot.branch ? " · " : null}
                {snapshot.branch ? `Branch: ${snapshot.branch}` : null}
              </div>
            ) : null}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function gitlabUnavailableCopy(reason: string): { title: string; detail: string } {
  switch (reason) {
    case "gitlab_redirect_forbidden":
      return {
        title: "GitLab repository redirect is not allowed",
        detail:
          "Web Context never follows GitLab repository redirects. Bind the repository at the exact configured GitLab origin, or use an Agent with local git/glab access. Webhook automation remains independent.",
      };
    case "gitlab_repository_unavailable":
      return {
        title: "GitLab repository or branch is unavailable",
        detail:
          "Confirm that the repository URL and branch exist and allow anonymous reads from First Tree Server. Private repositories remain available to Agents with local git/glab credentials, and Webhook automation can stay active.",
      };
    case "invalid_binding":
      return {
        title: "GitLab Context Tree binding is invalid",
        detail:
          "The repository provider, origin, connection, or branch no longer forms one valid live binding. Repair Team Settings; inbound Webhook automation remains a separate health state.",
      };
    default:
      return {
        title: "GitLab content is unavailable in Cloud",
        detail:
          "The anonymous GitLab repository refresh failed. Check the repository, branch, and network settings, or use an Agent with local git/glab access. Webhook automation remains independent.",
      };
  }
}

function EmptyChanges() {
  return (
    <div className="text-body" style={{ color: "var(--fg-3)" }}>
      No context updates in the past 7 days.
    </div>
  );
}

const OVERVIEW_DEFAULT_DEPTH = 1;
const OVERVIEW_CHANGED_BRANCH_DEPTH = 3;

type OverviewDatum = {
  id: string;
  parentId: string | null;
  sourceNodeId: string | null;
  title: string;
  path: string;
  changeType: ContextTreeChangeType | null;
  updateCount: number;
  isSummary: boolean;
  isExpanded: boolean;
  selected: boolean;
  selectedPath: boolean;
  muted: boolean;
};

type LayoutNode = OverviewDatum & {
  x: number;
  y: number;
  parent: LayoutNode | null;
};

type ChangeCounts = {
  added: number;
  edited: number;
  removed: number;
};

type ChangeGroup = {
  id: string;
  title: string;
  path: string;
  representativeNodeId: string;
  updateCount: number;
  changeCounts: ChangeCounts;
};

type PlacedChangeGroup = ChangeGroup & {
  selected: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

export function layoutTree(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
  expandedParents: Set<string>,
): LayoutNode[] {
  const overviewNodes = buildOverviewNodes(nodes, selectedNodeId, counts, expandedParents);
  if (overviewNodes.length === 0) return [];

  const root = stratify<OverviewDatum>()
    .id((node) => node.id)
    .parentId((node) => node.parentId)(overviewNodes)
    .sort((a, b) => {
      if (a.data.isSummary !== b.data.isSummary) return a.data.isSummary ? -1 : 1;
      return a.data.path.localeCompare(b.data.path);
    });
  const pointRoot = tree<OverviewDatum>().nodeSize([30, 170])(root);
  const points = pointRoot.descendants();
  const minX = Math.min(...points.map((point) => point.x));
  const laidOut = points.map((point) => ({
    ...point.data,
    x: 28 + point.y,
    y: 28 + point.x - minX,
    parent: null,
  }));

  return laidOut.map((node, _index, all) => ({
    ...node,
    parent: node.parentId ? (all.find((candidate) => candidate.id === node.parentId) ?? null) : null,
  }));
}

export function buildOverviewNodes(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
  expandedParents: Set<string>,
): OverviewDatum[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validNodes = nodes
    .filter((node) => !node.parentId || byId.has(node.parentId))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (validNodes.length === 0) return [];

  const childrenByParent = childMap(validNodes);
  const selectedPath = selectedPathIds(selectedNodeId, byId);
  const compactVisibleIds = new Set<string>();
  const depthById = new Map<string, number>();

  for (const node of validNodes) {
    const depth = nodeDepth(node, byId, depthById);
    const updateCount = counts.get(node.id) ?? 0;
    if (
      depth <= OVERVIEW_DEFAULT_DEPTH ||
      selectedPath.has(node.id) ||
      (updateCount > 0 && depth <= OVERVIEW_CHANGED_BRANCH_DEPTH)
    ) {
      addWithAncestors(node.id, byId, compactVisibleIds);
    }
  }

  let promotedSomething = true;
  while (promotedSomething) {
    promotedSomething = false;
    for (const parentId of [...compactVisibleIds]) {
      const hiddenChildren = (childrenByParent.get(parentId) ?? []).filter((child) => !compactVisibleIds.has(child.id));
      if (hiddenChildren.length === 1) {
        const only = hiddenChildren[0];
        if (only) {
          compactVisibleIds.add(only.id);
          promotedSomething = true;
        }
      }
    }
  }

  const visibleIds = new Set(compactVisibleIds);
  for (const parentId of expandedParents) {
    if (!visibleIds.has(parentId)) continue;
    for (const child of childrenByParent.get(parentId) ?? []) {
      visibleIds.add(child.id);
    }
  }

  const selectedActive = selectedPath.size > 0;
  const realNodes = validNodes
    .filter((node) => visibleIds.has(node.id))
    .map((node): OverviewDatum => {
      const updateCount = counts.get(node.id) ?? 0;
      const selectedPathNode = selectedPath.has(node.id);
      return {
        id: node.id,
        parentId: node.parentId && visibleIds.has(node.parentId) ? node.parentId : null,
        sourceNodeId: node.id,
        title: node.title,
        path: node.path,
        changeType: node.changeType,
        updateCount,
        isSummary: false,
        isExpanded: false,
        selected: selectedNodeId === node.id,
        selectedPath: selectedPathNode,
        muted: selectedActive && !selectedPathNode && updateCount === 0,
      };
    });

  const summaryNodes: OverviewDatum[] = [];
  for (const node of validNodes) {
    if (!visibleIds.has(node.id)) continue;
    const naturallyHidden = (childrenByParent.get(node.id) ?? []).filter((child) => !compactVisibleIds.has(child.id));
    if (naturallyHidden.length === 0) continue;
    const isExpanded = expandedParents.has(node.id);
    const changedHiddenCount = naturallyHidden.filter((child) => (counts.get(child.id) ?? 0) > 0).length;
    summaryNodes.push({
      id: `summary:${node.id}`,
      parentId: node.id,
      sourceNodeId: null,
      title: isExpanded ? "Show less" : summaryTitle(naturallyHidden.length, changedHiddenCount),
      path: `${node.path}/~summary`,
      changeType: null,
      updateCount: changedHiddenCount,
      isSummary: true,
      isExpanded,
      selected: false,
      selectedPath: selectedPath.has(node.id),
      muted: selectedActive && !selectedPath.has(node.id),
    });
  }

  return [...realNodes, ...summaryNodes];
}

function updateChangeNodes(nodes: ContextTreeNode[]): ContextTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.changeType) continue;
    addWithAncestors(node.id, byId, ids);
  }
  return nodes.filter((node) => ids.has(node.id));
}

function changeGroups(nodes: ContextTreeNode[]): ChangeGroup[] {
  const changedNodes = updateChangeNodes(nodes).filter((node) => node.changeType);
  if (changedNodes.length === 0) return [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, ChangeGroup>();

  for (const node of changedNodes) {
    const branch = topLevelBranch(node, byId);
    const existing = grouped.get(branch.id);
    if (existing) {
      grouped.set(branch.id, {
        ...existing,
        updateCount: existing.updateCount + 1,
        changeCounts: incrementChangeCount(existing.changeCounts, node.changeType),
        representativeNodeId: existing.representativeNodeId === branch.id ? node.id : existing.representativeNodeId,
      });
      continue;
    }

    grouped.set(branch.id, {
      id: branch.id,
      title: branch.title,
      path: branch.path,
      representativeNodeId: node.id,
      updateCount: 1,
      changeCounts: incrementChangeCount(emptyChangeCounts(), node.changeType),
    });
  }

  return [...grouped.values()]
    .sort((a, b) => b.updateCount - a.updateCount || a.path.localeCompare(b.path))
    .slice(0, 4);
}

function emptyChangeCounts(): ChangeCounts {
  return { added: 0, edited: 0, removed: 0 };
}

function incrementChangeCount(counts: ChangeCounts, type: ContextTreeChangeType | null): ChangeCounts {
  if (type === "added") return { ...counts, added: counts.added + 1 };
  if (type === "edited") return { ...counts, edited: counts.edited + 1 };
  if (type === "removed") return { ...counts, removed: counts.removed + 1 };
  return counts;
}

function changeBreakdownParts(
  counts: ChangeCounts,
): Array<{ type: ContextTreeChangeType; label: string; count: number }> {
  const parts: Array<{ type: ContextTreeChangeType; label: string; count: number }> = [];
  if (counts.added > 0) parts.push({ type: "added", label: "added", count: counts.added });
  if (counts.edited > 0) parts.push({ type: "edited", label: "edited", count: counts.edited });
  if (counts.removed > 0) parts.push({ type: "removed", label: "removed", count: counts.removed });
  return parts;
}

function selectedChangeGroupId(nodes: ContextTreeNode[], selectedNodeId: string | null): string | null {
  if (!selectedNodeId) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = byId.get(selectedNodeId);
  return selectedNode ? topLevelBranch(selectedNode, byId).id : null;
}

function placeChangeGroups(groups: ChangeGroup[], selectedGroupId: string | null): PlacedChangeGroup[] {
  const slots: Array<Pick<PlacedChangeGroup, "x" | "y" | "width" | "height" | "anchorX" | "anchorY">> = [
    { x: 96, y: 34, width: 196, height: 98, anchorX: 292, anchorY: 83 },
    { x: 628, y: 34, width: 196, height: 98, anchorX: 628, anchorY: 83 },
    { x: 96, y: 286, width: 196, height: 98, anchorX: 292, anchorY: 335 },
    { x: 628, y: 286, width: 196, height: 98, anchorX: 628, anchorY: 335 },
  ];
  const fallbackSlot = slots[slots.length - 1];
  if (!fallbackSlot) return [];

  return groups.map((group, index) => {
    const slot = slots[index] ?? fallbackSlot;
    return {
      ...group,
      ...slot,
      selected: group.id === selectedGroupId || (selectedGroupId === null && index === 0),
    };
  });
}

function connectionPath(group: PlacedChangeGroup): string {
  const centerX = 460;
  const centerY = 210;
  const direction = group.anchorX < centerX ? -1 : 1;
  const startX = centerX + direction * 124;
  const startY = centerY + (group.anchorY > centerY ? 48 : -48);
  const controlX = (startX + group.anchorX) / 2;
  const controlY = group.anchorY > centerY ? startY + 62 : startY - 62;
  return `M ${startX} ${startY} Q ${controlX} ${controlY} ${group.anchorX} ${group.anchorY}`;
}

function topLevelBranch(node: ContextTreeNode, byId: Map<string, ContextTreeNode>): ContextTreeNode {
  let current = node;
  let parent = current.parentId ? byId.get(current.parentId) : undefined;
  while (parent && parent.parentId !== null) {
    current = parent;
    parent = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return current;
}

function childMap(nodes: ContextTreeNode[]): Map<string, ContextTreeNode[]> {
  const childrenByParent = new Map<string, ContextTreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.path.localeCompare(b.path));
  }
  return childrenByParent;
}

function selectedPathIds(selectedNodeId: string | null, byId: Map<string, ContextTreeNode>): Set<string> {
  const pathIds = new Set<string>();
  let current = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  while (current) {
    pathIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return pathIds;
}

function addWithAncestors(nodeId: string, byId: Map<string, ContextTreeNode>, visibleIds: Set<string>): void {
  let current = byId.get(nodeId);
  while (current) {
    visibleIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
}

function nodeDepth(node: ContextTreeNode, byId: Map<string, ContextTreeNode>, depthById: Map<string, number>): number {
  const known = depthById.get(node.id);
  if (known !== undefined) return known;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const depth = parent ? nodeDepth(parent, byId, depthById) + 1 : 0;
  depthById.set(node.id, depth);
  return depth;
}

function summaryTitle(hiddenCount: number, changedHiddenCount: number): string {
  if (changedHiddenCount > 0) {
    return `Show ${hiddenCount} more · ${changedHiddenCount} changed`;
  }
  return `Show ${hiddenCount} more`;
}

function severityColor(severity: ContextTreeSnapshot["contextStatus"]["severity"]): string {
  if (severity === "ok") return "var(--success)";
  if (severity === "warning") return "var(--warning)";
  return "var(--danger)";
}

function redactRepoForDisplay(repo: string): string {
  return repo.replace(/(https?:\/\/)[^/@\s]+@/g, "$1[redacted]@");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function exactTimeLabel(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
