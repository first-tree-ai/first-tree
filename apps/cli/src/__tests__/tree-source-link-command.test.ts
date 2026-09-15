import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTreeSourceLinkCommand, treeSourceLinkCommand } from "../commands/tree/source-link.js";

const output = vi.hoisted(() => ({ result: vi.fn(), line: vi.fn(), isJsonMode: vi.fn(() => false) }));
vi.mock("../core/output.js", () => ({ print: output, isJsonMode: output.isJsonMode }));

const commit = "0123456789abcdef0123456789abcdef01234567";
const repo = "https://gitlab.example.com/group/tree.git";
const args = [
  "--repo",
  repo,
  "--commit",
  commit,
  "--path",
  "standards/mobile.md",
  "--gitlab-origin",
  "https://gitlab.example.com",
  "--gitlab-version",
  "11.11.3",
];

function command(extraArgs = args): Command {
  const cmd = new Command("source-link").exitOverride();
  treeSourceLinkCommand.configure?.(cmd);
  cmd.parse(extraArgs, { from: "user" });
  return cmd;
}

beforeEach(() => {
  vi.clearAllMocks();
  output.isJsonMode.mockReturnValue(false);
});

describe("tree source-link command", () => {
  it("prints the old GitLab URL without requiring member login or modifying the repository", () => {
    runTreeSourceLinkCommand({ command: command(), options: { json: false, debug: false, quiet: false } });
    expect(output.line).toHaveBeenCalledWith(
      `https://gitlab.example.com/group/tree/blob/${commit}/standards/mobile.md`,
    );
    expect(output.result).not.toHaveBeenCalled();
  });

  it("returns machine-readable source identity in JSON mode", () => {
    runTreeSourceLinkCommand({ command: command(), options: { json: true, debug: false, quiet: false } });
    expect(output.result).toHaveBeenCalledWith({
      url: `https://gitlab.example.com/group/tree/blob/${commit}/standards/mobile.md`,
      commit,
      gitlabVersion: "11.11.3",
    });
    expect(output.line).not.toHaveBeenCalled();
  });

  it("does not emit a source URL for the reported seven-character commit", () => {
    expect(() =>
      runTreeSourceLinkCommand({
        command: command(args.map((arg) => (arg === commit ? "4f437b2" : arg))),
        options: { json: true, debug: false, quiet: false },
      }),
    ).toThrow("complete 40- or 64-character");
    expect(output.line).not.toHaveBeenCalled();
    expect(output.result).not.toHaveBeenCalled();
  });
});
