import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findStaleAliases, formatStaleReason, type PinnedAgent, removeLocalAgent } from "../core/agent-prune.js";

/**
 * Pins the four cases that drove the rewrite:
 *   1. all aliases pinned to me → empty result
 *   2. agentId present in server response but on another client → "pinned-elsewhere"
 *   3. agentId not in server response at all → "unowned"
 *   4. broken / missing yaml → "unreadable" (must not throw — this is the
 *      junk-dir case that broke the previous loadAgents-based impl)
 *
 * The SDK call is injected as `listPinnedAgents`, so these tests don't
 * need to spin up a server or stub fetch.
 */

const THIS_CLIENT = "client_self";
const OTHER_CLIENT = "client_other";

function writeAlias(agentsDir: string, name: string, body: string): void {
  const dir = join(agentsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), body);
}

let agentsDir: string;
const originalHome = process.env.FIRST_TREE_HOME;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "fthub-prune-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("findStaleAliases", () => {
  it("returns empty when every local alias maps to a pinned agent on this client", async () => {
    writeAlias(agentsDir, "alpha", "agentId: 00000000-0000-0000-0000-00000000aaaa\nruntime: claude-code\n");
    writeAlias(agentsDir, "beta", "agentId: 00000000-0000-0000-0000-00000000bbbb\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000aaaa", clientId: THIS_CLIENT },
      { agentId: "00000000-0000-0000-0000-00000000bbbb", clientId: THIS_CLIENT },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toEqual([]);
  });

  it("keeps suspended aliases pinned to this client out of the prune set", async () => {
    writeAlias(agentsDir, "paused", "agentId: 00000000-0000-0000-0000-00000000ssss\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000ssss", clientId: THIS_CLIENT, status: "suspended" },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toEqual([]);
  });

  it("classifies an agentId pinned to a different client as pinned-elsewhere", async () => {
    writeAlias(agentsDir, "shared-name", "agentId: 00000000-0000-0000-0000-00000000cccc\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [{ agentId: "00000000-0000-0000-0000-00000000cccc", clientId: OTHER_CLIENT }];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      name: "shared-name",
      agentId: "00000000-0000-0000-0000-00000000cccc",
      reason: { kind: "pinned-elsewhere", clientId: OTHER_CLIENT },
    });
  });

  it("classifies an unknown agentId as unowned", async () => {
    writeAlias(agentsDir, "ghost", "agentId: 00000000-0000-0000-0000-00000000dead\nruntime: claude-code\n");

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      name: "ghost",
      agentId: "00000000-0000-0000-0000-00000000dead",
      reason: { kind: "unowned" },
    });
  });

  it("classifies a malformed yaml as unreadable (does not throw)", async () => {
    // Real-world junk: dir exists, yaml is empty / has no agentId — used to
    // crash the entire prune via Zod throwing inside loadAgents.
    writeAlias(agentsDir, "d", "this: is: not: valid: yaml: at: all\n  - broken");
    writeAlias(agentsDir, "no-id", "runtime: claude-code\n");
    // And a dir with no yaml at all.
    mkdirSync(join(agentsDir, "empty-dir"), { recursive: true });

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toHaveLength(3);
    for (const s of stale) {
      expect(s.agentId).toBeNull();
      expect(s.reason.kind).toBe("unreadable");
    }
    expect(stale.map((s) => s.name).sort()).toEqual(["d", "empty-dir", "no-id"]);
  });

  it("returns mixed results when good and bad aliases coexist", async () => {
    writeAlias(agentsDir, "active", "agentId: 00000000-0000-0000-0000-00000000aaaa\nruntime: claude-code\n");
    writeAlias(agentsDir, "moved", "agentId: 00000000-0000-0000-0000-00000000bbbb\nruntime: claude-code\n");
    writeAlias(agentsDir, "deleted", "agentId: 00000000-0000-0000-0000-00000000cccc\nruntime: claude-code\n");
    writeAlias(agentsDir, "junk", "");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000aaaa", clientId: THIS_CLIENT },
      { agentId: "00000000-0000-0000-0000-00000000bbbb", clientId: OTHER_CLIENT },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    const byName = Object.fromEntries(stale.map((s) => [s.name, s.reason]));
    expect(Object.keys(byName).sort()).toEqual(["deleted", "junk", "moved"]);
    expect(byName.moved).toEqual({ kind: "pinned-elsewhere", clientId: OTHER_CLIENT });
    expect(byName.deleted).toEqual({ kind: "unowned" });
    expect(byName.junk?.kind).toBe("unreadable");
  });

  it("returns empty when the agents dir does not exist", async () => {
    const stale = await findStaleAliases({
      agentsDir: join(agentsDir, "does-not-exist"),
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toEqual([]);
  });

  it("ignores entries that vanish before stat", async (ctx) => {
    try {
      symlinkSync(join(agentsDir, "missing"), join(agentsDir, "broken-link"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });

    expect(stale).toEqual([]);
  });

  it("formats stale reasons and removes local agent footprints", () => {
    const home = mkdtempSync(join(tmpdir(), "fthub-prune-home-"));
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config", "agents", "stale"), { recursive: true });
    mkdirSync(join(home, "data", "workspaces", "stale"), { recursive: true });
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "sessions", "stale.json"), "{}");

    expect(formatStaleReason({ kind: "unreadable", error: "bad yaml" })).toBe("unreadable: bad yaml");
    expect(formatStaleReason({ kind: "unowned" })).toContain("no longer owned");
    expect(formatStaleReason({ kind: "pinned-elsewhere", clientId: OTHER_CLIENT })).toContain(OTHER_CLIENT);

    removeLocalAgent("stale");

    expect(existsSync(join(home, "config", "agents", "stale"))).toBe(false);
    expect(existsSync(join(home, "data", "workspaces", "stale"))).toBe(false);
    expect(existsSync(join(home, "data", "sessions", "stale.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses a removal target that escapes the agent state roots", () => {
    const home = mkdtempSync(join(tmpdir(), "fthub-prune-home-"));
    process.env.FIRST_TREE_HOME = home;
    // Outside the config/data roots this call is allowed to touch.
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep\n");

    expect(() => removeLocalAgent("../../outside")).toThrow(/not a canonical agent name/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses to delete through a state-root symlink that resolves outside", () => {
    const home = mkdtempSync(join(tmpdir(), "fthub-prune-home-"));
    process.env.FIRST_TREE_HOME = home;
    // A canonical name, but the containing directory resolves elsewhere on disk.
    // `path.resolve` alone cannot see this; the guard must realpath it.
    const elsewhere = join(home, "elsewhere");
    mkdirSync(join(elsewhere, "victim"), { recursive: true });
    writeFileSync(join(elsewhere, "victim", "keep.txt"), "keep\n");
    mkdirSync(join(home, "config"), { recursive: true });
    symlinkSync(elsewhere, join(home, "config", "agents"));

    expect(() => removeLocalAgent("victim")).toThrow(/resolves outside/);
    expect(existsSync(join(elsewhere, "victim", "keep.txt"))).toBe(true);
    expect(readFileSync(join(elsewhere, "victim", "keep.txt"), "utf8")).toBe("keep\n");
    // The link itself is untouched too — nothing was attempted.
    expect(lstatSync(join(home, "config", "agents")).isSymbolicLink()).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps a missing target a no-op", () => {
    const home = mkdtempSync(join(tmpdir(), "fthub-prune-home-"));
    process.env.FIRST_TREE_HOME = home;
    expect(() => removeLocalAgent("never-installed")).not.toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});
