import {
  contextDecisionFromImpactNote,
  parseContextImpactNotes,
  parseExactContextSourceLink,
} from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { resolveContextTreeSourceLink } from "../core/context-tree-source-link.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const origin = "https://gitlab.example.com:8443";
const source = {
  repoUrl: `${origin}/group/sub/context-tree.git`,
  commit,
  nodePath: "engineering/mobile interaction.md",
  gitlabInstanceOrigin: origin,
};

describe("Context Tree source link CLI core", () => {
  it("preserves a parenthesized filename through an Agent Markdown impact note", () => {
    const nodePath = "engineering/guide (mobile).md";
    const result = resolveContextTreeSourceLink({ ...source, nodePath, gitlabVersion: "11.11.3" });
    const [note] = parseContextImpactNotes(
      [
        "Done.",
        "",
        "> How Context Tree affected this work\\",
        "> **Options narrowed:** Mobile rules constrained the implementation.\\",
        `> Context Tree source: [Mobile rules](${result.url})`,
      ].join("\n"),
    );
    expect(note).toBeDefined();
    expect(note && contextDecisionFromImpactNote(note)?.evidence[0]?.nodePath).toBe(nodePath);
  });
  it("queries the bound GitLab web host and produces an old-server citation that the parser accepts", () => {
    const run = vi.fn(() => JSON.stringify({ version: "11.11.3" }));
    const result = resolveContextTreeSourceLink(source, run);
    expect(run).toHaveBeenCalledWith(
      "glab",
      ["api", "version", "--hostname", "gitlab.example.com:8443"],
      process.cwd(),
    );
    expect(result).toEqual({
      url: `${origin}/group/sub/context-tree/blob/${commit}/engineering/mobile%20interaction.md`,
      commit,
      gitlabVersion: "11.11.3",
    });
    expect(parseExactContextSourceLink(result.url)?.nodePath).toBe(source.nodePath);
  });

  it("reuses a verified modern version without a second forge request", () => {
    const run = vi.fn();
    const result = resolveContextTreeSourceLink({ ...source, gitlabVersion: "18.0.0-ee" }, run);
    expect(result.url).toContain(`/context-tree/-/blob/${commit}/`);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the web origin rather than the SSH transport port", () => {
    const run = vi.fn(() => JSON.stringify({ version: "11.11.3" }));
    const result = resolveContextTreeSourceLink(
      { ...source, repoUrl: "ssh://git@gitlab.example.com:2222/group/tree.git" },
      run,
    );
    expect(result.url).toContain(`${origin}/group/tree/blob/`);
    expect(run).toHaveBeenCalledWith(
      "glab",
      ["api", "version", "--hostname", "gitlab.example.com:8443"],
      process.cwd(),
    );
  });

  it("does not query GitLab for a GitHub citation", () => {
    const run = vi.fn();
    const result = resolveContextTreeSourceLink(
      { repoUrl: "git@github.com:example/tree.git", commit, nodePath: "a.md" },
      run,
    );
    expect(result.url).toBe(`https://github.com/example/tree/blob/${commit}/a.md`);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["4f437b2", "main", "a".repeat(41)])("rejects non-exact commit %s before a forge request", (value) => {
    const run = vi.fn();
    expect(() => resolveContextTreeSourceLink({ ...source, commit: value }, run)).toThrow(
      "complete 40- or 64-character",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("requires the matching GitLab origin before using its credentials", () => {
    const run = vi.fn();
    expect(() => resolveContextTreeSourceLink({ ...source, gitlabInstanceOrigin: null }, run)).toThrow(
      "--gitlab-origin",
    );
    expect(() =>
      resolveContextTreeSourceLink({ ...source, gitlabInstanceOrigin: "https://other.example.com" }, run),
    ).toThrow("origin");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["{}", "not json", '{"version":null}'])("does not guess after an invalid version response %s", (response) => {
    expect(() => resolveContextTreeSourceLink(source, () => response)).toThrow("Cannot determine");
  });

  it("does not expose glab error output or fall back to a guessed route", () => {
    const run = vi.fn(() => {
      throw new Error("private response secret=example");
    });
    expect(() => resolveContextTreeSourceLink(source, run)).toThrow("Cannot determine the GitLab instance version");
    expect(() => resolveContextTreeSourceLink(source, run)).not.toThrow("secret=");
  });

  it("rejects malformed explicit version evidence instead of querying or guessing", () => {
    const run = vi.fn();
    expect(() => resolveContextTreeSourceLink({ ...source, gitlabVersion: "unknown" }, run)).toThrow("Cannot build");
    expect(run).not.toHaveBeenCalled();
  });
});
