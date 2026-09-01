import { type AgentChatStatus, type ChatParticipantDetail, compareMainStatus } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause, Play } from "lucide-react";
import { useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import {
  chatSessionEventsQueryKey,
  resumeSession,
  sessionQueryKey,
  suspendSession,
  terminateSession,
} from "../../api/sessions.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { toneOf } from "../../lib/tones.js";
import { AgentSessionResetConfirmDialog } from "../agent-lifecycle-confirm-dialog.js";
import { Avatar } from "../avatar.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { useToast } from "../ui/toast.js";
import { AgentHovercard } from "./agent-hovercard.js";

/**
 * AgentStatusPanel — the chat right sidebar's per-agent composite-status
 * board. One `GET /chats/:chatId/agent-status` call drives every row;
 * freshness rides the admin WS invalidation of `["chat-agent-status", id]`
 * (see use-admin-ws) — no per-agent poll.
 *
 * Each row reads its main status through the shared `viewOf` vocabulary:
 * a status-point (StatusGlyph) on the avatar plus one static text label. The
 * center timeline owns activity/tool detail and error navigation; the sidebar
 * stays a calm identity + status + lightweight-control surface.
 */
export function AgentStatusPanel({
  chatId,
  agents,
  canManage,
  canRemove,
  onRemove,
  order = "fixed",
  compact = false,
}: {
  chatId: string;
  /** Non-human agent participants, in display order. */
  agents: ChatParticipantDetail[];
  /** Whether the caller may pause a given agent. */
  canManage: (agentId: string) => boolean;
  /** Whether the caller may remove a given agent from the chat roster. */
  canRemove?: (agentId: string) => boolean;
  /** Opens the remove-confirm flow for the given agent row. */
  onRemove?: (agent: ChatParticipantDetail) => void;
  /** `fixed` keeps `agents` order (sidebar); `priority` sorts by attention
   *  (compose) so the most urgent agent is on top. */
  order?: "fixed" | "priority";
  /** Tighter row padding for the dense sidebar roster. The compose-bar usage
   *  keeps the roomier default. */
  compact?: boolean;
}) {
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000, // safety net; the WS invalidation is the live path
  });
  // Per the per-chat-runtime authority refactor: working is per-chat
  // freshness stamp the server self-heals from; no local stale-clear ticker
  // needed. The admin-WS delta pushes the recomputed status down.

  const byAgent = new Map<string, AgentChatStatus>((statuses ?? []).map((s) => [s.agentId, s]));

  const ordered =
    order === "priority"
      ? [...agents].sort((a, b) => {
          const ma = byAgent.get(a.agentId)?.main ?? "offline";
          const mb = byAgent.get(b.agentId)?.main ?? "offline";
          return compareMainStatus(ma, mb);
        })
      : agents;

  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      {ordered.map((agent) => (
        <AgentStatusRow
          key={agent.agentId}
          chatId={chatId}
          agent={agent}
          status={byAgent.get(agent.agentId) ?? null}
          canManage={canManage(agent.agentId)}
          removeFromChat={
            canRemove?.(agent.agentId) === true && onRemove ? { onRequest: () => onRemove(agent) } : undefined
          }
          compact={compact}
        />
      ))}
    </div>
  );
}

/**
 * Pause is offered for any live session on a reachable agent
 * (`engagement === "active"`) — working or idle. That is the only session
 * state Pause can suspend (anything else 409s), and the active-idle case
 * matters: it is the only path to Reset, since Reset is offered only for
 * stopped sessions. Offline rows get no Pause. Exported for tests.
 */
export function canPauseStatus(status: AgentChatStatus | null): boolean {
  return status?.reachable === true && status.engagement === "active";
}

export function canResumeStatus(status: AgentChatStatus | null): boolean {
  return status?.engagement === "suspended";
}

/**
 * Reset (clear the chat session) is offered only for a STOPPED session —
 * `suspended`, or failed (session state `errored` projects as engagement
 * `none` with the errored axis set) — on a reachable agent whose live client
 * negotiated the composite Reset protocol (`sessionResetSupported`).
 * Active sessions never offer Reset, even when idle: a running agent must be
 * paused first, so Reset never tears down an in-flight turn. Offline agents
 * and clients on an older protocol version are excluded: without the whole
 * handshake there is no proof the old provider-session mapping is gone and no
 * way to release the rows the client parks meanwhile. Exported for tests.
 */
export function canResetSessionStatus(status: AgentChatStatus | null): boolean {
  if (!status || !status.reachable || status.sessionResetSupported !== true) return false;
  return status.engagement === "suspended" || (status.engagement === "none" && status.errored);
}

function AgentStatusRow({
  chatId,
  agent,
  status,
  canManage,
  removeFromChat,
  compact,
}: {
  chatId: string;
  agent: ChatParticipantDetail;
  status: AgentChatStatus | null;
  canManage: boolean;
  removeFromChat?: { onRequest: () => void };
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const suspendMut = useMutation({
    mutationFn: () => suspendSession(agent.agentId, chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const resumeMut = useMutation({
    mutationFn: () => resumeSession(agent.agentId, chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  // Reset is offered only for stopped sessions (suspended / errored) on a
  // capable online client, so a single terminate in apply-ack mode is the
  // whole operation: the server holds the request until the client confirms
  // it dropped the local provider-session mapping, then atomically evicts and
  // clears traces. A 200 + evicted response IS the fresh-session proof; every
  // failure arrives as an HTTP error and leaves the stopped row untouched,
  // so the action stays retryable (even after a reload).
  const resetMut = useMutation({
    mutationFn: async () => {
      const result = await terminateSession(agent.agentId, chatId, { waitForApply: true });
      if (result.state !== "evicted") {
        // Defensive: the apply-ack route only returns 200 for evicted rows —
        // anything else must surface as a retryable failure, never success.
        throw new Error("The session could not be cleared. Try again.");
      }
    },
    onSuccess: () => {
      setResetOpen(false);
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: sessionQueryKey(agent.agentId, chatId) });
      queryClient.invalidateQueries({ queryKey: chatSessionEventsQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      addToast({
        title: "Session reset",
        description: `Send @${agent.name} a new message in this chat to start fresh.`,
      });
    },
    onError: (error) => {
      // Fail honestly: the dialog stays open so the user can retry, and no
      // success toast appears for a half-completed suspend → terminate pair.
      // Refresh the row so the retry acts on the real session state.
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      addToast({
        title: "Reset failed",
        description: error instanceof Error ? error.message : "The session could not be reset. Try again.",
      });
    },
  });

  const view = status ? viewOf(status.main) : null;
  const showPause = canManage && canPauseStatus(status);
  const showResume = canManage && canResumeStatus(status);
  const sessionReset = canManage && canResetSessionStatus(status) ? { onRequest: () => setResetOpen(true) } : undefined;

  return (
    <>
      <div
        className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2_5)",
          padding: compact ? "var(--sp-1_25) var(--sp-2)" : "var(--sp-1_75) var(--sp-2)",
          borderRadius: "var(--radius-input)",
        }}
      >
        <AgentHovercard
          agentId={agent.agentId}
          chatId={chatId}
          name={agent.displayName}
          placement="left"
          triggerClassName="block shrink-0 cursor-pointer rounded-full"
          participantType="agent"
          sessionReset={sessionReset}
          removeFromChat={removeFromChat}
        >
          <span className="relative block" style={{ width: 28, height: 28 }}>
            <Avatar
              src={agent.avatarImageUrl}
              name={agent.displayName}
              seed={agent.agentId}
              colorToken={agent.avatarColorToken}
              size={28}
            />
            {view ? (
              <span
                className="absolute"
                style={{
                  right: -2,
                  bottom: -3,
                }}
              >
                <StatusGlyph
                  colorVar={view.colorVar}
                  shape={view.shape}
                  pulse={view.pulse}
                  size={9}
                  ariaLabel={view.label}
                  separator
                />
              </span>
            ) : null}
          </span>
        </AgentHovercard>

        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
          <AgentHovercard
            agentId={agent.agentId}
            chatId={chatId}
            name={agent.displayName}
            placement="left"
            triggerClassName="block max-w-full cursor-pointer truncate text-left text-subtitle hover:underline"
            participantType="agent"
            sessionReset={sessionReset}
            removeFromChat={removeFromChat}
          >
            {agent.displayName}
          </AgentHovercard>
          <SecondLine status={status} />
        </div>

        {showPause ? <PauseButton onClick={() => suspendMut.mutate()} isPending={suspendMut.isPending} /> : null}
        {showResume ? <ResumeButton onClick={() => resumeMut.mutate()} isPending={resumeMut.isPending} /> : null}
      </div>
      {sessionReset || resetOpen ? (
        // Mounted on `resetOpen` too: after a failed reset the server may
        // already report the session evicted (command undelivered / cleanup
        // raced), which hides the card action — the open dialog must remain
        // the user's retry affordance instead of unmounting mid-recovery.
        <AgentSessionResetConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          label={agent.displayName}
          onConfirm={() => resetMut.mutate()}
          pending={resetMut.isPending}
        />
      ) : null}
    </>
  );
}

/**
 * The row's static second line — present for every state so all rows stay
 * uniform. Working/tool activity and error navigation belong to the center
 * timeline; this roster intentionally renders status only.
 */
function SecondLine({ status }: { status: AgentChatStatus | null }) {
  if (!status) {
    return (
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        …
      </div>
    );
  }
  if (status.main === "failed") {
    return (
      <div className="flex">
        <StatePill tone="error" label="Failed" />
      </div>
    );
  }
  // working / idle / paused / offline → the state word in its own colour,
  // sans. Failed alone keeps the attention pill above.
  const view = viewOf(status.main);
  return (
    <div className="text-caption" style={{ color: view.colorVar }}>
      {view.label}
      {/* Why this idle agent is not finished: its provider is parked on work
          it started itself and wakes up on its own. Rendered as a quieter
          qualifier, not a second state — the dot stays idle. The `ready`
          check is defense in depth: the qualifier reads as a footnote on the
          word "Idle", so it must never trail Offline or Paused even if the
          server were to send it alongside one. */}
      {status.main === "ready" && status.backgroundWork === true ? (
        <span style={{ color: "var(--fg-4)" }}> · Background task</span>
      ) : null}
    </div>
  );
}

/**
 * A subtle tinted pill for the failed state — the state that *should* jump out.
 * Quiet states stay dot + plain coloured text.
 * sans (not mono): the status word is natural language. Geometry mirrors
 * DenseBadge; tone colours come from the shared `tones` map.
 */
function StatePill({ tone, label }: { tone: "blocked" | "error" | "idle"; label: string }) {
  const t = toneOf(tone);
  return (
    <span
      className="text-caption inline-flex items-center"
      style={{
        background: t.bg,
        color: t.fg,
        border: `var(--hairline) solid ${t.bd}`,
        padding: "var(--hairline) var(--sp-1_75)",
        borderRadius: "var(--radius-chip)",
        lineHeight: 1.6,
      }}
    >
      {label}
    </span>
  );
}

/** Compact one-click Pause (suspend). Reversible — the next message in the
 *  chat upserts the session back to active — so no confirm step. */
function PauseButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={isPending ? "Pausing agent" : "Pause agent"}
      title="Pause this agent in this chat"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-warn-soft)] hover:text-[var(--fg-warn-strong)] hover:border-[var(--fg-warn-strong)]"
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: isPending ? "var(--bg-sunken)" : "transparent",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <Pause className="h-3 w-3" aria-hidden="true" fill="currentColor" strokeWidth={0} />
      )}
      {isPending ? "Pausing" : "Pause"}
    </button>
  );
}

function ResumeButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={isPending ? "Resuming agent" : "Resume agent"}
      title="Resume this agent in this chat"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-2)]"
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: isPending ? "var(--bg-sunken)" : "transparent",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <Play className="h-3 w-3" aria-hidden="true" fill="currentColor" strokeWidth={0} />
      )}
      {isPending ? "Resuming" : "Resume"}
    </button>
  );
}
