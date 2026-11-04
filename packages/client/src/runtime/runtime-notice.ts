import {
  type ProviderRetryEventPayload,
  type ProviderRetryScope,
  RUNTIME_NOTICE_METADATA_KEY,
  type RuntimeProvider,
  runtimeProviderLabel,
} from "@first-tree/shared";
import { daemonEnvFile } from "@first-tree/shared/config";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import { redactErrorPreview } from "./redact-error-preview.js";

export function shouldPostProviderFailureRuntimeNotice(payload: ProviderRetryEventPayload): boolean {
  return (
    payload.category !== "runtime_transport" &&
    (payload.event === "provider_failure_terminal" || payload.event === "provider_retry_exhausted")
  );
}

export function isRuntimeSessionProofFailure(payload: ProviderRetryEventPayload): boolean {
  return payload.category === "runtime_transport";
}

export function formatProviderFailureRuntimeNotice(payload: ProviderRetryEventPayload): string {
  const managedStateNotice = managedSkillsStateNotice(payload);
  const lead = managedStateNotice ?? noticeLead(payload);
  const detail = redactErrorPreview((payload.messagePreview ?? "").trim(), 500);
  return detail.length > 0
    ? `${lead} ${managedStateNotice ? "Details" : "Original provider message"}: ${detail}`
    : lead;
}

function managedSkillsStateNotice(payload: ProviderRetryEventPayload): string | null {
  if (payload.category !== "configuration") return null;
  let recovery: string;
  switch (payload.reasonCode) {
    case "managed_skills_state_invalid":
      recovery = "Have the machine operator check and restore the local Skills state from a matching backup.";
      break;
    case "managed_skills_state_unsupported":
      recovery = "Use a First Tree client that supports the saved Skills state version.";
      break;
    case "managed_skills_state_untrusted":
      recovery = "Have the machine operator repair the local Skills state path so it is a regular file.";
      break;
    default:
      return null;
  }
  return (
    `First Tree could not ${actionLabel(payload.scope)} because the local Skills state needs attention. ` +
    "Automatic retries have stopped and existing workspace files were preserved. " +
    `${recovery} After repair, send your request again in this chat.`
  );
}

export async function postProviderFailureRuntimeNotice(
  sdk: FirstTreeHubSDK,
  chatId: string,
  payload: ProviderRetryEventPayload,
): Promise<void> {
  await sdk.sendMessage(chatId, {
    source: "api",
    format: "text",
    content: formatProviderFailureRuntimeNotice(payload),
    metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
    purpose: "agent-final-text",
  });
}

function actionLabel(scope: ProviderRetryScope): string {
  switch (scope) {
    case "session_start":
      return "start this chat session";
    case "session_resume":
      return "resume this chat session";
    case "provider_turn":
      return "run this turn";
  }
}

function noticeLead(payload: ProviderRetryEventPayload): string {
  if (payload.scope === "provider_turn" && isClaudeProvider(payload.provider)) {
    return claudeProviderTurnNoticeLead(payload);
  }
  const provider = runtimeProviderLabel(payload.provider);
  const action = actionLabel(payload.scope);
  switch (payload.category) {
    case "runtime_transport":
      return `First Tree could not ${action}: the runtime session proof is stale. Rebinding the agent runtime.`;
    case "credential":
      if (payload.provider === "antigravity") {
        return (
          provider +
          " could not " +
          action +
          ": credentials need attention. On this machine run agy once to sign in, then retry."
        );
      }
      if (payload.provider === "amp") {
        return `${provider} could not ${action}: credentials need attention. On this machine run \`amp login\`, then retry.`;
      }
      if (payload.provider === "deepseek-harness") {
        return `${provider} could not ${action}: credentials need attention. On this machine set \`DEEPSEEK_API_KEY\`, then retry.`;
      }
      if (payload.provider === "pi") {
        return `${provider} could not ${action}: credentials need attention. On this machine run \`pi\`, then enter \`/login\`, and retry.`;
      }
      return `${provider} could not ${action}: credentials need attention. Please sign in again and retry.`;
    case "capability":
      return `${provider} could not ${action}: the runtime is unavailable on this machine. Install or repair the runtime, then retry.`;
    case "configuration":
      if (payload.provider === "cursor" && payload.reasonCode === "cursor_resume_stuck") {
        return `${provider} could not ${action}: the previous Cursor conversation could not be resumed. Send your message again in this chat to continue with a fresh Cursor session.`;
      }
      return `${provider} could not ${action}: runtime configuration needs attention. Fix the configuration and retry.`;
    case "deterministic_input":
      return `${provider} could not ${action}: this input cannot be processed as-is. Adjust the request or start a new thread, then retry.`;
    case "provider_capacity":
      return `${provider} could not ${action}: provider capacity or quota blocked the request. Retry after the provider is available or the limit resets.`;
    case "transient_transport":
      return `${provider} could not ${action} after retrying a transient provider or network failure. Retry when the provider is available.`;
    case "unknown":
      return `${provider} could not ${action}: the provider stopped with an unknown terminal failure. Retry after checking the runtime.`;
  }
  return `${provider} could not ${action}: ${payload.reasonCode}.`;
}

function isClaudeProvider(provider: RuntimeProvider): boolean {
  return provider === "claude-code" || provider === "claude-code-tui";
}

function claudeProviderTurnNoticeLead(payload: ProviderRetryEventPayload): string {
  if (payload.category === "credential") {
    if (isEgressForbiddenText(payload.messagePreview ?? "")) return claudeEgressForbiddenLead();
    return "Claude Code could not run this turn: Anthropic rejected the local Claude authentication. Run `claude auth login` on this machine. After sign-in completes, send your message again in this chat.";
  }
  if (payload.category === "provider_capacity") {
    if (payload.reasonCode === "provider_billing_limit") {
      return "Claude Code could not run this turn: Anthropic reports insufficient account balance or unavailable billing credits. Add credits or switch accounts, then retry.";
    }
    if (payload.reasonCode === "provider_rate_limited") {
      return "Claude Code could not run this turn: Anthropic rate-limited this account. Wait for the limit to reset, then retry.";
    }
    return "Claude Code could not run this turn: Anthropic reported a capacity or usage limit. Wait or switch accounts, then retry.";
  }
  if (payload.category === "transient_transport") {
    return (
      "Claude Code could not run this turn: the provider API connection failed after retry handling. " +
      `If you use a proxy or custom ANTHROPIC_BASE_URL, make sure the daemon has those env vars via ${daemonEnvFile()} ` +
      "and that the upstream endpoint is reachable, then retry."
    );
  }
  if (payload.category === "configuration") {
    return "Claude Code could not run this turn: the Claude runtime configuration is invalid. Update the agent or provider configuration, then retry.";
  }
  if (payload.category === "deterministic_input") {
    return "Claude Code could not run this turn: Anthropic rejected this request as invalid. Adjust the request or configuration, then retry.";
  }
  if (payload.category === "capability") {
    return "Claude Code could not run this turn: the Claude runtime is not launchable on this machine. Fix the local runtime, then retry.";
  }
  return "Claude Code could not run this turn: Claude SDK reported a provider failure. Retry after checking the provider status.";
}

export function isEgressForbiddenText(text: string): boolean {
  return /request not allowed/i.test(text) && /\b403\b|forbidden/i.test(text);
}

function claudeEgressForbiddenLead(): string {
  return (
    'Claude Code could not run this turn: Anthropic returned 403 "Request not allowed". ' +
    "This status comes back before authentication, so it is usually NOT a login problem — most often " +
    "the background daemon cannot reach Anthropic (e.g. it is not going through your network proxy). " +
    `Check, in order: (1) if you use a proxy, give the daemon its proxy env via ${daemonEnvFile()} ` +
    "and restart it; (2) your Anthropic plan / region entitlement; (3) only if those are fine, " +
    "re-authenticate with `claude auth login`."
  );
}
