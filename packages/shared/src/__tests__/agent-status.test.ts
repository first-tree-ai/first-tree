import { describe, expect, it } from "vitest";
import {
  agentChatStatusSchema,
  agentMainStatusSchema,
  buildAgentChatStatus,
  compareMainStatus,
  type DeriveMainStatusInput,
  deriveMainStatus,
  MAIN_STATUS_PRIORITY,
} from "../schemas/agent-status.js";

/** A "reachable, idle, no session" baseline — reduces to `ready`. */
const base: DeriveMainStatusInput = {
  reachable: true,
  errored: false,
  working: false,
  engagement: "none",
};

describe("deriveMainStatus — priority projection", () => {
  it("offline gates everything when unreachable", () => {
    // Every other flag is true, yet unreachable wins.
    expect(
      deriveMainStatus({
        reachable: false,
        errored: true,
        working: true,
        engagement: "active",
      }),
    ).toBe("offline");
  });

  it("failed beats working / paused", () => {
    expect(deriveMainStatus({ ...base, errored: true, working: true, engagement: "suspended" })).toBe("failed");
  });

  it("working beats paused", () => {
    expect(deriveMainStatus({ ...base, working: true, engagement: "suspended" })).toBe("working");
  });

  it("suspended session with nothing else → paused", () => {
    expect(deriveMainStatus({ ...base, engagement: "suspended" })).toBe("paused");
  });

  it("reachable + idle + active/none session → ready", () => {
    expect(deriveMainStatus({ ...base, engagement: "active" })).toBe("ready");
    expect(deriveMainStatus({ ...base, engagement: "none" })).toBe("ready");
  });

  it("each axis flag overrides every lower-priority one in turn", () => {
    // working over paused is covered above; assert the full descending ladder
    // by toggling one higher flag at a time on top of a suspended session.
    expect(deriveMainStatus({ ...base, engagement: "suspended" })).toBe("paused");
    expect(deriveMainStatus({ ...base, engagement: "suspended", working: true })).toBe("working");
    expect(deriveMainStatus({ ...base, engagement: "suspended", working: true, errored: true })).toBe("failed");
    expect(
      deriveMainStatus({
        ...base,
        reachable: false,
        engagement: "suspended",
        working: true,
        errored: true,
      }),
    ).toBe("offline");
  });
});

describe("compareMainStatus", () => {
  it("sorts statuses by attention priority", () => {
    const shuffled = ["ready", "working", "offline", "paused", "failed"] as const;
    expect([...shuffled].sort(compareMainStatus)).toEqual([...MAIN_STATUS_PRIORITY]);
  });

  it("priority list and enum cover the same values", () => {
    expect([...MAIN_STATUS_PRIORITY].sort()).toEqual([...agentMainStatusSchema.options].sort());
  });
});

describe("agentChatStatusSchema", () => {
  it("parses a valid composite", () => {
    const parsed = agentChatStatusSchema.parse({
      agentId: "agent-1",
      main: "working",
      reachable: true,
      engagement: "active",
      working: true,
      errored: false,
      activity: null,
    });
    expect(parsed.main).toBe("working");
  });

  it("accepts statusReason without feeding it into main derivation", () => {
    const parsed = agentChatStatusSchema.parse({
      agentId: "agent-1",
      main: "ready",
      reachable: true,
      engagement: "active",
      working: false,
      errored: false,
      activity: null,
      statusReason: {
        kind: "waiting",
        severity: "warning",
        provider: "codex",
        scope: "session_resume",
        category: "provider_capacity",
        reasonCode: "provider_capacity",
        label: "Waiting for provider capacity",
      },
    });
    expect(parsed.main).toBe("ready");
    expect(parsed.statusReason?.kind).toBe("waiting");
  });

  it("rejects the runtime-A vocabulary (idle/blocked are not composite main values)", () => {
    // Guards against the two-vocabulary confusion this module exists to prevent.
    expect(agentMainStatusSchema.safeParse("idle").success).toBe(false);
    expect(agentMainStatusSchema.safeParse("blocked").success).toBe(false);
  });

  it("rejects a payload whose main contradicts the other fields", () => {
    const contradictory = {
      agentId: "agent-1",
      main: "ready", // but working:true ⇒ deriveMainStatus = "working"
      reachable: true,
      engagement: "active",
      working: true,
      errored: false,
      activity: null,
    };
    expect(agentChatStatusSchema.safeParse(contradictory).success).toBe(false);
  });
});

describe("buildAgentChatStatus", () => {
  it("derives main from the axes and satisfies the schema invariant", () => {
    const status = buildAgentChatStatus({
      agentId: "agent-1",
      reachable: true,
      errored: false,
      working: true,
      engagement: "active",
    });
    expect(status.main).toBe("working");
    expect(agentChatStatusSchema.safeParse(status).success).toBe(true);
  });

  it("carries background work without letting it touch main", () => {
    // The marker says "idle, but it wakes itself up" — a descriptive
    // qualifier like `activity` / `statusReason`, never a fifth state.
    const status = buildAgentChatStatus({
      agentId: "agent-1",
      reachable: true,
      errored: false,
      working: false,
      engagement: "active",
      backgroundWork: true,
    });
    expect(status.main).toBe("ready");
    expect(status.backgroundWork).toBe(true);
    expect(agentChatStatusSchema.safeParse(status).success).toBe(true);
  });

  it("omits background work when absent so the field never lands as false", () => {
    const status = buildAgentChatStatus({
      agentId: "agent-1",
      reachable: true,
      errored: false,
      working: false,
      engagement: "active",
    });
    expect(status.backgroundWork).toBeUndefined();
  });

  it("an unreachable agent builds to offline regardless of other axes", () => {
    const status = buildAgentChatStatus({
      agentId: "agent-1",
      reachable: false,
      errored: true,
      working: true,
      engagement: "active",
    });
    expect(status.main).toBe("offline");
    expect(agentChatStatusSchema.safeParse(status).success).toBe(true);
  });

  it("preserves statusReason while deriving main from the axes", () => {
    const status = buildAgentChatStatus({
      agentId: "agent-1",
      reachable: true,
      errored: false,
      working: false,
      engagement: "active",
      statusReason: {
        kind: "retrying",
        severity: "info",
        provider: "claude-code",
        scope: "provider_turn",
        category: "transient_transport",
        reasonCode: "provider_transient_transport",
        label: "Retrying provider",
        attempt: 1,
        maxAttempts: 3,
      },
    });
    expect(status.main).toBe("ready");
    expect(status.statusReason?.kind).toBe("retrying");
    expect(agentChatStatusSchema.safeParse(status).success).toBe(true);
  });
});
