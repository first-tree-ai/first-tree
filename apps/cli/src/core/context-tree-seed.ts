import { SdkError } from "@first-tree/client";
import {
  type ContextTreeSeedPreflightErrorCode,
  type ContextTreeSeedPreflightRequest,
  type ContextTreeSeedPreflightState,
  contextTreeSeedPreflightErrorCodeSchema,
  contextTreeSeedPreflightResponseSchema,
} from "@first-tree/shared";
import { AuthRefreshFailedError } from "./bootstrap.js";
import { classifyContextTreeReadError } from "./context-tree-binding.js";

export type ContextTreeSeedStage = "input" | "authority" | "configuration";

export type ContextTreeSeedPreflightCliErrorCode =
  | ContextTreeSeedPreflightErrorCode
  | "CONTEXT_TREE_SEED_INVALID_INPUT"
  | "CONTEXT_TREE_SEED_PREFLIGHT_INVALID"
  | "CONTEXT_TREE_SEED_AUTHENTICATION_FAILED"
  | "CONTEXT_TREE_SEED_TEAM_ACCESS_DENIED"
  | "CONTEXT_TREE_SEED_SERVER_INCOMPATIBLE"
  | "CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE";

export type ContextTreeSeedAuthorityReader = {
  preflightMemberContextTreeSeed(
    teamId: string,
    request: ContextTreeSeedPreflightRequest,
    options: { retry: false },
  ): Promise<unknown>;
};

export type PreflightContextTreeSeedInput = {
  teamId: string;
};

export type ContextTreeSeedPreflight = {
  teamId: string;
  state: ContextTreeSeedPreflightState;
  gitlabConnection: { id: string; instanceOrigin: string } | null;
};

type ContextTreeSeedPreflightErrorOptions = {
  stage: ContextTreeSeedStage;
  exitCode: 1 | 2 | 3 | 6;
  httpStatus?: number;
};

export class ContextTreeSeedPreflightCliError extends Error {
  readonly status = "failed";
  readonly stage: ContextTreeSeedStage;
  readonly exitCode: 1 | 2 | 3 | 6;
  readonly httpStatus?: number;

  constructor(
    readonly code: ContextTreeSeedPreflightCliErrorCode,
    message: string,
    options: ContextTreeSeedPreflightErrorOptions,
  ) {
    super(message);
    this.name = "ContextTreeSeedPreflightCliError";
    this.stage = options.stage;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

/** Read the explicit Team's current Seed authority and binding without mutation. */
export async function preflightContextTreeSeed(
  reader: ContextTreeSeedAuthorityReader,
  input: PreflightContextTreeSeedInput,
): Promise<ContextTreeSeedPreflight> {
  const teamId = validateTeamId(input.teamId);

  let rawAuthority: unknown;
  try {
    rawAuthority = await reader.preflightMemberContextTreeSeed(
      teamId,
      {},
      {
        retry: false,
      },
    );
  } catch (error) {
    throw classifyAuthorityFailure(error);
  }

  const parsed = contextTreeSeedPreflightResponseSchema.safeParse(rawAuthority);
  if (!parsed.success || parsed.data.organizationId !== teamId) {
    throw new ContextTreeSeedPreflightCliError(
      "CONTEXT_TREE_SEED_PREFLIGHT_INVALID",
      "The Server returned an invalid Context Tree Seed preflight response for the explicit Team.",
      { stage: "authority", exitCode: 1 },
    );
  }

  return { teamId, state: parsed.data.state, gitlabConnection: parsed.data.gitlabConnection };
}

function validateTeamId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || hasUnsafeTextCharacter(value)) {
    throw new ContextTreeSeedPreflightCliError(
      "CONTEXT_TREE_SEED_INVALID_INPUT",
      "--team must be an explicit non-empty Team id without padding or control characters.",
      { stage: "input", exitCode: 2 },
    );
  }
  return value;
}

function classifyAuthorityFailure(error: unknown): ContextTreeSeedPreflightCliError {
  // Known Server preflight codes keep their exact identity and wording; the
  // splits below apply only to failures the Server did not already classify.
  if (error instanceof SdkError) {
    const parsedCode = contextTreeSeedPreflightErrorCodeSchema.safeParse(error.code);
    if (parsedCode.success) return serverPreflightFailure(parsedCode.data, error.statusCode);
    if (error.statusCode === 401) return authenticationFailure(error.statusCode);
    if (error.statusCode === 403) return teamAccessDeniedFailure(error.statusCode);
    if (error.statusCode === 404) return serverIncompatibleFailure(error.statusCode);
    if (error.statusCode >= 500) return preflightUnavailableFailure(error.statusCode);
  }

  const classified = classifyContextTreeReadError(error);
  const httpStatus = classified.httpStatus;
  if (error instanceof AuthRefreshFailedError || classified.category === "authentication") {
    return authenticationFailure(httpStatus);
  }
  if (classified.category === "timeout" || classified.category === "connection") {
    return preflightUnavailableFailure(httpStatus);
  }

  // Safe generic fallback: the authority could not be established, and nothing
  // more specific can be claimed without leaking server detail.
  return new ContextTreeSeedPreflightCliError(
    "CONTEXT_TREE_SEED_AUTHORITY_FAILED",
    "The selected Team's current Context Tree Seed authority could not be checked online.",
    {
      stage: "authority",
      exitCode: classified.exitCode,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  );
}

function authenticationFailure(httpStatus: number | undefined): ContextTreeSeedPreflightCliError {
  return new ContextTreeSeedPreflightCliError(
    "CONTEXT_TREE_SEED_AUTHENTICATION_FAILED",
    "Authentication failed before the selected Team could authorize Context Tree Seed. Sign in again and retry.",
    { stage: "authority", exitCode: 3, ...(httpStatus === undefined ? {} : { httpStatus }) },
  );
}

function teamAccessDeniedFailure(httpStatus: number): ContextTreeSeedPreflightCliError {
  // One message covers both genuine causes — the signed-in member is not an
  // active member of the selected Team, or the Team id itself is wrong — so
  // the response never confirms whether a given Team id exists.
  return new ContextTreeSeedPreflightCliError(
    "CONTEXT_TREE_SEED_TEAM_ACCESS_DENIED",
    "The signed-in member is not an active member of the selected Team, or the Team id is incorrect. Verify the exact Team id and membership, then retry.",
    { stage: "authority", exitCode: 3, httpStatus },
  );
}

function serverIncompatibleFailure(httpStatus: number): ContextTreeSeedPreflightCliError {
  return new ContextTreeSeedPreflightCliError(
    "CONTEXT_TREE_SEED_SERVER_INCOMPATIBLE",
    "The connected First Tree Server does not serve the Context Tree Seed preflight route (HTTP 404). A self-hosted Server older than this CLI is the common cause; upgrade the Server and retry.",
    { stage: "authority", exitCode: 1, httpStatus },
  );
}

function preflightUnavailableFailure(httpStatus: number | undefined): ContextTreeSeedPreflightCliError {
  return new ContextTreeSeedPreflightCliError(
    "CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE",
    "The Context Tree Seed preflight is temporarily unavailable (network, timeout, or Server error). Retry shortly; if it persists, check connectivity to the First Tree Server.",
    { stage: "authority", exitCode: 6, ...(httpStatus === undefined ? {} : { httpStatus }) },
  );
}

function serverPreflightFailure(
  code: ContextTreeSeedPreflightErrorCode,
  httpStatus: number,
): ContextTreeSeedPreflightCliError {
  const messages: Record<ContextTreeSeedPreflightErrorCode, string> = {
    CONTEXT_TREE_SEED_AUTHORITY_FAILED:
      "The selected Team could not authorize Context Tree Seed for the signed-in member.",
    CONTEXT_TREE_SEED_NEEDS_ADMIN:
      "Context Tree Seed needs an active Admin of the selected Team. Ask a Team Admin to continue with the same Team id.",
    CONTEXT_TREE_SEED_CONFIGURATION_INVALID:
      "The selected Team's Context Tree binding is invalid and must be repaired by an Admin before Seed can continue.",
  };
  const configurationFailure = code === "CONTEXT_TREE_SEED_CONFIGURATION_INVALID";
  return new ContextTreeSeedPreflightCliError(code, messages[code], {
    stage: configurationFailure ? "configuration" : "authority",
    exitCode: configurationFailure ? 1 : 3,
    httpStatus,
  });
}

function hasUnsafeTextCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029)
    );
  });
}
