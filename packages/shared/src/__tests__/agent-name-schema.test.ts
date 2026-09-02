import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_REGEX,
  agentSchema,
  createAgentSchema,
  findReservedAgentMetadataKey,
  isReservedAgentName,
  listAgentsQuerySchema,
  RESERVED_AGENT_NAMES,
  switchAgentRuntimeSchema,
  updateAgentSchema,
  userAgentMetadataSchema,
} from "../schemas/agent.js";

/**
 * Pins the tightened agent-name rules introduced in Phase 1 of the
 * agent-naming refactor (see first-tree-context:agent-hub/agent-naming.md §3.1). These
 * constraints align `createAgentSchema` with `MENTION_REGEX` so every
 * valid name can be @-mentioned and CLI-flag-parsed.
 */

describe("AGENT_NAME_REGEX", () => {
  it("accepts a well-formed lowercase slug", () => {
    expect(AGENT_NAME_REGEX.test("alice")).toBe(true);
    expect(AGENT_NAME_REGEX.test("coder-agent")).toBe(true);
    expect(AGENT_NAME_REGEX.test("a1")).toBe(true);
    expect(AGENT_NAME_REGEX.test("bot_07")).toBe(true);
  });

  it("rejects leading hyphen or underscore (CLI-flag / markdown ambiguity)", () => {
    expect(AGENT_NAME_REGEX.test("-coder")).toBe(false);
    expect(AGENT_NAME_REGEX.test("_internal")).toBe(false);
  });

  it("rejects uppercase, unicode, and punctuation", () => {
    expect(AGENT_NAME_REGEX.test("Coder")).toBe(false);
    expect(AGENT_NAME_REGEX.test("coder.agent")).toBe(false);
    expect(AGENT_NAME_REGEX.test("团队agent")).toBe(false);
  });

  it("rejects empty string and over-length input", () => {
    expect(AGENT_NAME_REGEX.test("")).toBe(false);
    const tooLong = "a".repeat(AGENT_NAME_MAX_LENGTH + 1);
    expect(AGENT_NAME_REGEX.test(tooLong)).toBe(false);
  });

  it("accepts a 64-char name at exact max length", () => {
    const max = `a${"b".repeat(AGENT_NAME_MAX_LENGTH - 1)}`;
    expect(max.length).toBe(AGENT_NAME_MAX_LENGTH);
    expect(AGENT_NAME_REGEX.test(max)).toBe(true);
  });
});

describe("isReservedAgentName", () => {
  it("flags every entry in the reserved list", () => {
    for (const n of RESERVED_AGENT_NAMES) {
      expect(isReservedAgentName(n)).toBe(true);
    }
  });

  it("does not flag ordinary names", () => {
    expect(isReservedAgentName("alice")).toBe(false);
    expect(isReservedAgentName("coder-agent")).toBe(false);
  });
});

describe("agent metadata guards", () => {
  it("finds the first reserved metadata key and ignores ordinary metadata", () => {
    expect(findReservedAgentMetadataKey(undefined)).toBeNull();
    expect(findReservedAgentMetadataKey({ theme: "dark" })).toBeNull();
    expect(findReservedAgentMetadataKey({ runtimeSwitch: { target: "codex" }, runtimeSession: {} })).toBe(
      "runtimeSwitch",
    );
    expect(findReservedAgentMetadataKey({ theme: "dark", runtimeSession: { active: true } })).toBe("runtimeSession");
  });

  it("rejects user metadata that tries to write reserved runtime keys", () => {
    expect(userAgentMetadataSchema.safeParse({ theme: "dark" }).success).toBe(true);

    const result = userAgentMetadataSchema.safeParse({
      runtimeSession: {
        routeId: "session-1",
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["runtimeSession"]);
    }
  });
});

describe("listAgentsQuerySchema", () => {
  it.each([
    [undefined, false],
    ["", false],
    [true, true],
    ["true", true],
    ["1", true],
    [false, false],
    ["false", false],
    ["0", false],
  ] as const)("normalizes addressableOnly=%s", (value, expected) => {
    expect(listAgentsQuerySchema.parse({ addressableOnly: value }).addressableOnly).toBe(expected);
  });

  it("rejects unsupported addressableOnly values", () => {
    expect(listAgentsQuerySchema.safeParse({ addressableOnly: "yes" }).success).toBe(false);
  });
});

describe("createAgentSchema", () => {
  it("accepts valid inputs", () => {
    expect(createAgentSchema.safeParse({ name: "alice", type: "human" }).success).toBe(true);
    expect(createAgentSchema.safeParse({ type: "agent" }).success).toBe(true);
  });

  it("rejects a reserved name via refine", () => {
    const res = createAgentSchema.safeParse({ name: "admin", type: "human" });
    expect(res.success).toBe(false);
  });

  it("rejects a leading-hyphen name via regex", () => {
    const res = createAgentSchema.safeParse({ name: "-rogue", type: "human" });
    expect(res.success).toBe(false);
  });

  it("rejects a 65-char name via max length", () => {
    const tooLong = "a".repeat(AGENT_NAME_MAX_LENGTH + 1);
    const res = createAgentSchema.safeParse({ name: tooLong, type: "human" });
    expect(res.success).toBe(false);
  });

  it("rejects disabled providers at public create and switch edges", () => {
    expect(createAgentSchema.safeParse({ type: "agent", runtimeProvider: "antigravity" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ type: "agent", runtimeProvider: "claude-code-tui" }).success).toBe(false);
    expect(
      switchAgentRuntimeSchema.safeParse({
        clientId: "client-1",
        runtimeProvider: "antigravity",
        confirmLocalDataLoss: true,
      }).success,
    ).toBe(false);
  });
});

describe("Phase 2: displayName is non-null on the wire", () => {
  const baseRow = {
    uuid: "uuid-1",
    name: "alice",
    organizationId: "org-1",
    type: "human" as const,
    delegateMention: null,
    inboxId: "inbox_uuid-1",
    status: "active",
    visibility: "organization" as const,
    metadata: {},
    managerId: "mem-1",
    clientId: null,
    runtimeProvider: "claude-code" as const,
    avatarColorToken: null,
    avatarImageUrl: null,
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
  };

  it("agentSchema rejects a row with null displayName", () => {
    const res = agentSchema.safeParse({ ...baseRow, displayName: null });
    expect(res.success).toBe(false);
  });

  it("agentSchema accepts a non-null displayName", () => {
    const res = agentSchema.safeParse({ ...baseRow, displayName: "Alice" });
    expect(res.success).toBe(true);
  });

  it("updateAgentSchema rejects `displayName: null` (clearing the field is no longer allowed)", () => {
    const res = updateAgentSchema.safeParse({ displayName: null });
    expect(res.success).toBe(false);
  });

  it("updateAgentSchema rejects an empty-string displayName (min 1 char)", () => {
    const res = updateAgentSchema.safeParse({ displayName: "" });
    expect(res.success).toBe(false);
  });

  it("updateAgentSchema accepts a non-empty displayName", () => {
    const res = updateAgentSchema.safeParse({ displayName: "Alice v2" });
    expect(res.success).toBe(true);
  });

  it("updateAgentSchema rejects type updates", () => {
    expect(updateAgentSchema.safeParse({ type: "agent" }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ type: "human" }).success).toBe(false);
  });

  it("updateAgentSchema accepts omitted displayName (leaves row untouched)", () => {
    const res = updateAgentSchema.safeParse({});
    expect(res.success).toBe(true);
  });
});
