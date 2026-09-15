import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerAgentCommands } from "../commands/agent/index.js";
import { registerChatCommands } from "../commands/chat/index.js";
import { registerComputerCommands } from "../commands/computer/index.js";
import { registerConfigCommands } from "../commands/config/index.js";
import { registerDaemonCommands } from "../commands/daemon/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerOrgCommands } from "../commands/org/index.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";

function command(root: Command, name: string): Command {
  const found = root.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

function subcommands(root: Command, name: string): string[] {
  return command(root, name)
    .commands.map((entry) => entry.name())
    .sort();
}

describe("CLI command registration", () => {
  it("registers the top-level command surface", () => {
    const root = new Command();

    registerLoginCommand(root);
    registerLogoutCommand(root);
    registerStatusCommand(root);
    registerDoctorCommand(root);
    registerUpgradeCommand(root);
    registerAgentCommands(root);
    registerChatCommands(root);
    registerComputerCommands(root);
    registerOrgCommands(root);
    registerDaemonCommands(root);
    registerConfigCommands(root);
    registerTreeCommands(root);

    expect(root.commands.map((entry) => entry.name()).sort()).toEqual([
      "agent",
      "chat",
      "computer",
      "config",
      "daemon",
      "doctor",
      "login",
      "logout",
      "org",
      "status",
      "tree",
      "upgrade",
    ]);
  });

  it("registers agent, chat, computer, daemon, config, and org subcommands", () => {
    const root = new Command();
    registerAgentCommands(root);
    registerChatCommands(root);
    registerComputerCommands(root);
    registerDaemonCommands(root);
    registerConfigCommands(root);
    registerOrgCommands(root);

    expect(subcommands(root, "agent")).toEqual([
      "add",
      "bind",
      "config",
      "create",
      "debug",
      "list",
      "prune",
      "remove",
      "reset",
      "session",
      "status",
      "workspace",
    ]);
    expect(subcommands(root, "chat")).toEqual([
      "archive",
      "ask",
      "create",
      "history",
      "invite",
      "list",
      "open",
      "send",
      "set-topic",
      "update",
    ]);
    expect(subcommands(root, "computer")).toEqual(["reset"]);
    expect(subcommands(root, "daemon")).toEqual([
      "doctor",
      "ensure-service",
      "home-info",
      "install-claude",
      "install-codex",
      "probe",
      "refresh-unit",
      "repair-ownership",
      "restart",
      "start",
      "status",
      "stop",
      "supervise",
    ]);
    expect(subcommands(root, "config")).toEqual(["get", "set", "show"]);
    expect(subcommands(root, "org")).toEqual(["bind-tree", "context-tree"]);
  });

  it("registers nested agent and tree command groups", () => {
    const root = new Command();
    registerAgentCommands(root);
    registerTreeCommands(root);

    const agent = command(root, "agent");
    expect(subcommands(agent, "bind")).toEqual(["client"]);
    expect(subcommands(agent, "session")).toEqual(["list", "resume", "suspend", "terminate"]);
    expect(subcommands(agent, "workspace")).toEqual(["clean"]);

    const tree = command(root, "tree");
    // `verify` survived the 2026-06 cleanup, `tree` is the narrow hierarchy
    // browser added back for agents and scripted consumers, and `init` was
    // reintroduced in 2026-07 as the agent/local-`gh` tree-repo creation path;
    // `review` is the narrow App-backed verdict publisher, and `io` is the
    // agent-scoped durable Context Tree read/write feed a value audit reads
    // instead of mining local runtime transcripts.
    expect(tree.commands.map((entry) => entry.name()).sort()).toEqual([
      "init",
      "io",
      "local",
      "read",
      "review",
      "seed",
      "source-link",
      "tree",
      "verify",
      "write",
    ]);
  });

  it("registers Context Tree set and review-config without changing the parent read options", () => {
    const root = new Command();
    registerOrgCommands(root);

    const contextTree = command(command(root, "org"), "context-tree");
    const set = command(contextTree, "set");
    const reviewConfig = command(contextTree, "review-config");
    const optionNames = (cmd: Command) => cmd.options.map((option) => option.long).sort();

    expect(contextTree.commands.map((entry) => entry.name())).toEqual(["set", "review-config"]);
    expect(optionNames(contextTree)).toEqual(["--agent"]);
    expect(optionNames(set)).toEqual(["--agent", "--branch"]);
    expect(optionNames(reviewConfig)).toEqual(["--agent", "--as-member", "--org"]);
    expect(set.registeredArguments.map((argument) => argument.name())).toEqual(["repo"]);
  });

  it("keeps important options on high-risk commands", () => {
    const root = new Command();
    registerLoginCommand(root);
    registerAgentCommands(root);
    registerDaemonCommands(root);
    registerOrgCommands(root);
    registerTreeCommands(root);

    const optionNames = (cmd: Command) => cmd.options.map((option) => option.long).sort();

    expect(optionNames(command(root, "login"))).toEqual(["--force-switch", "--no-start"]);
    expect(optionNames(command(command(root, "agent"), "create"))).toEqual([
      "--client-id",
      "--display-name",
      "--org",
      "--runtime",
      "--server",
      "--type",
    ]);
    expect(optionNames(command(command(root, "daemon"), "start"))).toEqual(["--foreground", "--no-interactive"]);
    expect(optionNames(command(command(root, "org"), "bind-tree"))).toEqual(["--branch", "--org"]);
    expect(optionNames(command(command(root, "org"), "context-tree"))).toEqual(["--agent"]);
    expect(optionNames(command(command(root, "tree"), "read"))).toEqual(["--snapshot", "--team"]);
    expect(optionNames(command(command(root, "tree"), "tree"))).toEqual([
      "--expect-branch",
      "--expect-remote",
      "--level",
      "--no-pull",
      "--pattern",
      "--tree-path",
    ]);
    expect(optionNames(command(command(command(root, "tree"), "local"), "resolve"))).toEqual(["--ensure", "--intent"]);
    expect(optionNames(command(command(root, "tree"), "write"))).toEqual(["--github-login", "--snapshot", "--team"]);
  });

  it("exposes help for the Context Tree browser command", () => {
    const root = new Command();
    registerTreeCommands(root);

    const help = command(command(root, "tree"), "tree").helpInformation();

    expect(help).toContain("Browse Context Tree nodes as a hierarchy.");
    expect(help).toContain("--level <depth>");
    expect(help).toContain("--pattern <pattern>");
  });

  it("exposes read-only help for strict task-scoped Read activation", () => {
    const root = new Command();
    registerTreeCommands(root);

    const help = command(command(root, "tree"), "read").helpInformation();

    expect(help).toContain("Activate a strict task-scoped Context Tree read snapshot.");
    expect(help).toContain("--team <team-id>");
    expect(help).toContain("--snapshot <directory>");
  });

  it("exposes stateless help for clean source-backed Write preflight", () => {
    const root = new Command();
    registerTreeCommands(root);

    const help = command(command(root, "tree"), "write").helpInformation();

    expect(help).toContain("Preflight a clean source-backed Context Tree Write against one exact snapshot.");
    expect(help).toContain("--github-login <login>");
  });
});
