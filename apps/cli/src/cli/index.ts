#!/usr/bin/env node

// MUST be the first import: this side-effect module sets
// `process.env.FIRST_TREE_HOME` from the channel default AND installs the
// channel-resolved CLI binding into `@first-tree/client`, before any other
// module loads `@first-tree/shared/config` or instantiates ClientRuntime.
// Re-ordering this line after a config-touching or runtime-instantiating
// import re-introduces the multi-env footgun where staging/dev binaries
// silently fall back to the prod home and prod CLI name.
import "../core/channel-env.js";
import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent/index.js";
import { registerChatCommands } from "../commands/chat/index.js";
import { registerComputerCommands } from "../commands/computer/index.js";
import { registerConfigCommands } from "../commands/config/index.js";
import { registerContextCommands } from "../commands/context/index.js";
import { registerCronCommands } from "../commands/cron/index.js";
import { registerDaemonCommands } from "../commands/daemon/index.js";
import { registerDocCommands } from "../commands/doc/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerFeishuCommands } from "../commands/feishu/index.js";
import { registerGithubCommands } from "../commands/github/index.js";
import { registerGitlabCommands } from "../commands/gitlab/index.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerOrgCommands } from "../commands/org/index.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import { channelConfig } from "../core/channel.js";
import { COMMAND_VERSION } from "../core/version.js";
import { configureCliRuntime } from "./runtime.js";

const program = new Command();

program
  .name(channelConfig.binName)
  .description("First Tree — Context Tree and agent collaboration in one CLI")
  .version(COMMAND_VERSION);

configureCliRuntime(program);

// ── Top-level shortcuts (single-command verbs) ──────────────────────────

registerLoginCommand(program);
registerLogoutCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerUpgradeCommand(program);

// ── Namespaces ─────────────────────────────────────────────────────────

registerAgentCommands(program);
registerChatCommands(program);
registerComputerCommands(program);
registerCronCommands(program);
registerDocCommands(program);
registerFeishuCommands(program);
registerGithubCommands(program);
registerGitlabCommands(program);
registerOrgCommands(program);
registerDaemonCommands(program);
registerConfigCommands(program);
registerContextCommands(program);

registerTreeCommands(program);

program.parse();
