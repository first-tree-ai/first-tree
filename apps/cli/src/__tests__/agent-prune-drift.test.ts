import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The preflight resolves every target, then the delete loop re-checks each one.
 * Those are two separate resolutions, so the value that passed the check is not
 * necessarily the value about to be removed. This file moves the state root on
 * the second resolution of every path — as a bind mount or a swapped symlinked
 * ancestor would — and asserts the command refuses instead of deleting the path
 * it validated earlier.
 */
const resolver = vi.hoisted(() => ({ homes: [] as string[], seen: new Set<string>() }));

/** macOS reaches the same temp directory as both `/var/...` and `/private/var/...`. */
function logicalPath(path: string): string {
  return path.replace(/^\/private/u, "");
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realNative = actual.realpathSync.native;
  const driftingNative = ((path: string, ...rest: unknown[]) => {
    const key = String(path);
    const logical = logicalPath(key);
    const home = resolver.homes.find((candidate) => logical.startsWith(candidate));
    if (home !== undefined) {
      if (resolver.seen.has(logical)) {
        // Same root, different on-disk location than the preflight saw.
        return `/drifted${logical.slice(home.length)}`;
      }
      resolver.seen.add(logical);
    }
    return (realNative as (p: string, ...r: unknown[]) => string)(key, ...rest);
  }) as typeof realNative;
  const realpathSyncMock = Object.assign((path: string) => realNative(path), { native: driftingNative });
  return { ...actual, realpathSync: realpathSyncMock };
});

import { removeLocalAgent } from "../core/agent-prune.js";

let home: string;
const originalHome = process.env.FIRST_TREE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fthub-prune-drift-"));
  process.env.FIRST_TREE_HOME = home;
  resolver.homes = [home, realpathSync.native(home)].map(logicalPath);
  resolver.seen.clear();
});

afterEach(() => {
  process.env.FIRST_TREE_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("removeLocalAgent root drift", () => {
  it("refuses when a re-check resolves somewhere other than the preflighted path", () => {
    mkdirSync(join(home, "config", "agents", "victim"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "victim", "agent.yaml"), "agentId: a\n");
    mkdirSync(join(home, "data", "workspaces", "victim"), { recursive: true });
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "sessions", "victim.json"), "{}");

    expect(() => removeLocalAgent("victim")).toThrow(/now resolves to/);
    // Nothing was removed: the refusal happened before the first rmSync.
    expect(existsSync(join(home, "config", "agents", "victim", "agent.yaml"))).toBe(true);
    expect(existsSync(join(home, "data", "workspaces", "victim"))).toBe(true);
    expect(existsSync(join(home, "data", "sessions", "victim.json"))).toBe(true);
  });
});
