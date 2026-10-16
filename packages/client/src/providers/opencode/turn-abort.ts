export type OpenCodeTurnAbortCause = "timeout" | "superseded" | "session_inactive" | "lifecycle";

export type OpenCodeTurnAbortDisposition = "silent" | "settle";

export type OpenCodeTurnAbortRecord = {
  cause: OpenCodeTurnAbortCause;
  disposition: OpenCodeTurnAbortDisposition;
};

/** Stable classifier input for timeout retries — must match shared transient-transport matching. */
export const OPENCODE_TURN_ABORT_TIMEOUT_CLASSIFICATION_MESSAGE =
  "OpenCode turn aborted or timed out before a safe terminal event";

export type OpenCodeTurnAbortState = {
  terminalReasons: readonly string[];
  sawProviderActivity: boolean;
  text: readonly string[];
};

export type OpenCodeTurnAbortSettlementPolicy = {
  classificationError: string;
};

export function dispositionForOpenCodeTurnAbort(cause: OpenCodeTurnAbortCause): OpenCodeTurnAbortDisposition {
  return cause === "superseded" ? "silent" : "settle";
}

export function resolveOpenCodeTurnAbortCause(input: {
  turnGeneration: number;
  currentGeneration: number;
  sessionActive: boolean;
  timedOut: boolean;
  abortSignal: AbortSignal;
}): OpenCodeTurnAbortCause {
  if (input.timedOut) return "timeout";
  if (!input.sessionActive) return "session_inactive";
  if (input.currentGeneration !== input.turnGeneration) return "superseded";
  if (input.abortSignal.aborted) return "lifecycle";
  return "lifecycle";
}

export function inferOpenCodeTurnAbortRecord(input: {
  turnGeneration: number;
  currentGeneration: number;
  sessionActive: boolean;
  timedOut: boolean;
  abortSignal: AbortSignal;
}): OpenCodeTurnAbortRecord {
  const cause = resolveOpenCodeTurnAbortCause(input);
  return { cause, disposition: dispositionForOpenCodeTurnAbort(cause) };
}

export function describeOpenCodeTurnAbortFailure(input: {
  cause: OpenCodeTurnAbortCause;
  turnTimeoutMs: number;
  state: OpenCodeTurnAbortState;
}): string {
  const timeoutSeconds = Math.round(input.turnTimeoutMs / 1000);
  const lead = {
    timeout: `OpenCode turn timed out after ${timeoutSeconds}s before a safe terminal event (step_finish)`,
    superseded: "OpenCode turn was superseded by a newer delivery before a safe terminal event (step_finish)",
    session_inactive:
      "OpenCode turn ended because the session became inactive before a safe terminal event (step_finish)",
    lifecycle: "OpenCode turn was aborted by runtime lifecycle before a safe terminal event (step_finish)",
  }[input.cause];

  const hints: string[] = [];
  if (input.state.terminalReasons.length === 0) {
    hints.push("no step_finish event received");
  } else {
    hints.push(
      `observed ${input.state.terminalReasons.length} terminal event${input.state.terminalReasons.length === 1 ? "" : "s"}`,
    );
  }
  if (input.state.sawProviderActivity && input.state.text.length === 0) {
    hints.push("provider activity without assistant text");
  }
  if (input.state.text.length > 0) {
    hints.push("partial assistant text was captured");
  }

  return `${lead}. ${hints.join("; ")}.`;
}

export function settlementPolicyForOpenCodeTurnAbort(cause: OpenCodeTurnAbortCause): OpenCodeTurnAbortSettlementPolicy {
  switch (cause) {
    case "timeout":
      return { classificationError: OPENCODE_TURN_ABORT_TIMEOUT_CLASSIFICATION_MESSAGE };
    case "superseded":
      return { classificationError: OPENCODE_TURN_ABORT_TIMEOUT_CLASSIFICATION_MESSAGE };
    case "session_inactive":
      return {
        classificationError: "OpenCode session became inactive before a safe terminal event",
      };
    case "lifecycle":
      return {
        classificationError: "OpenCode turn aborted by runtime lifecycle before a safe terminal event",
      };
  }
}
