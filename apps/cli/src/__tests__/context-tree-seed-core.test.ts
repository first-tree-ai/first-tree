import { SdkError } from "@first-tree/client";
import { describe, expect, it, vi } from "vitest";
import { AuthRefreshFailedError } from "../core/bootstrap.js";
import { type ContextTreeSeedAuthorityReader, preflightContextTreeSeed } from "../core/context-tree-seed.js";

function authorityReader(result: unknown): {
  reader: ContextTreeSeedAuthorityReader;
  preflight: ReturnType<typeof vi.fn>;
} {
  const preflight = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { reader: { preflightMemberContextTreeSeed: preflight }, preflight };
}

describe("Context Tree Seed preflight core", () => {
  it("returns the explicit Team's current unbound state with one non-retrying authority read", async () => {
    const { reader, preflight } = authorityReader({
      organizationId: "team-a",
      state: { status: "unbound", branch: "trunk" },
      gitlabConnection: null,
    });

    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).resolves.toEqual({
      teamId: "team-a",
      state: { status: "unbound", branch: "trunk" },
      gitlabConnection: null,
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledWith("team-a", {}, { retry: false });
  });

  it("returns the Server current binding without Workspace or default-Team input", async () => {
    const response = {
      organizationId: "team-a",
      state: {
        status: "bound",
        binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      },
      gitlabConnection: { id: "connection-1", instanceOrigin: "https://gitlab.internal:8443" },
    };
    const { reader } = authorityReader(response);

    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).resolves.toEqual({
      teamId: "team-a",
      state: response.state,
      gitlabConnection: response.gitlabConnection,
    });
  });

  it("rejects missing, padded, and unsafe Team ids before Server work", async () => {
    for (const teamId of ["", " team-a", "team-a\n"]) {
      const { reader, preflight } = authorityReader({});
      await expect(preflightContextTreeSeed(reader, { teamId })).rejects.toMatchObject({
        code: "CONTEXT_TREE_SEED_INVALID_INPUT",
        stage: "input",
        exitCode: 2,
      });
      expect(preflight).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the Server response belongs to another Team or has mixed state", async () => {
    const { reader } = authorityReader({
      organizationId: "team-b",
      state: { status: "unbound", branch: "main" },
    });
    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_PREFLIGHT_INVALID",
      stage: "authority",
    });
  });

  it("maps active-member Needs Admin without leaking the Server body", async () => {
    const { reader } = authorityReader(
      new SdkError(403, "private detail=do-not-leak", { code: "CONTEXT_TREE_SEED_NEEDS_ADMIN" }),
    );

    const error = await preflightContextTreeSeed(reader, { teamId: "team-a" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONTEXT_TREE_SEED_NEEDS_ADMIN", stage: "authority", exitCode: 3 });
    expect(String((error as Error).message)).toContain("Team Admin");
    expect(String((error as Error).message)).not.toContain("private detail");
    expect(String((error as Error).message)).not.toContain("do-not-leak");
  });

  it("preserves invalid configuration as a repairable binding-stage failure", async () => {
    const { reader } = authorityReader(
      new SdkError(409, "raw invalid setting", { code: "CONTEXT_TREE_SEED_CONFIGURATION_INVALID" }),
    );

    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_CONFIGURATION_INVALID",
      stage: "configuration",
      exitCode: 1,
    });
  });

  it("does not issue a hidden second authority request after transport failure", async () => {
    const { reader, preflight } = authorityReader(new Error("socket hang up"));
    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      stage: "authority",
    });
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it("maps an unclassified 401 to the authentication failure without leaking the Server body", async () => {
    const { reader } = authorityReader(new SdkError(401, "token detail=do-not-leak"));

    const error = await preflightContextTreeSeed(reader, { teamId: "team-a" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "CONTEXT_TREE_SEED_AUTHENTICATION_FAILED",
      stage: "authority",
      exitCode: 3,
      httpStatus: 401,
    });
    expect(String((error as Error).message)).toContain("Sign in again");
    expect(String((error as Error).message)).not.toContain("do-not-leak");
  });

  it("maps a refresh failure to the same authentication failure", async () => {
    const { reader } = authorityReader(new AuthRefreshFailedError("refresh rejected"));

    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_AUTHENTICATION_FAILED",
      stage: "authority",
      exitCode: 3,
    });
  });

  it("maps an unclassified 403 to Team access denial without existence leakage", async () => {
    const { reader } = authorityReader(new SdkError(403, "membership detail=do-not-leak"));

    const error = await preflightContextTreeSeed(reader, { teamId: "team-a" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "CONTEXT_TREE_SEED_TEAM_ACCESS_DENIED",
      stage: "authority",
      exitCode: 3,
      httpStatus: 403,
    });
    // One message covers "not a member" and "wrong Team id" so the response
    // never confirms whether the Team exists.
    expect(String((error as Error).message)).toContain("not an active member of the selected Team");
    expect(String((error as Error).message)).toContain("Team id is incorrect");
    expect(String((error as Error).message)).not.toContain("do-not-leak");
  });

  it("maps a missing preflight route (404) to Server incompatibility", async () => {
    const { reader } = authorityReader(new SdkError(404, "route not found"));

    const error = await preflightContextTreeSeed(reader, { teamId: "team-a" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "CONTEXT_TREE_SEED_SERVER_INCOMPATIBLE",
      stage: "authority",
      exitCode: 1,
      httpStatus: 404,
    });
    expect(String((error as Error).message)).toContain("upgrade the Server");
  });

  it("maps 5xx and transport failures to a retryable preflight unavailability", async () => {
    const { reader } = authorityReader(new SdkError(503, "temporary outage"));
    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE",
      stage: "authority",
      exitCode: 6,
      httpStatus: 503,
    });

    const timeout = authorityReader(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }));
    await expect(preflightContextTreeSeed(timeout.reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE",
      stage: "authority",
      exitCode: 6,
    });
  });

  it("keeps a safe generic fallback for unclassified failures", async () => {
    const { reader } = authorityReader(new SyntaxError("unexpected token"));
    await expect(preflightContextTreeSeed(reader, { teamId: "team-a" })).rejects.toMatchObject({
      code: "CONTEXT_TREE_SEED_AUTHORITY_FAILED",
      stage: "authority",
    });
  });
});
