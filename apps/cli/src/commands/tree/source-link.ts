import type { Command } from "commander";
import { resolveContextTreeSourceLink } from "../../core/context-tree-source-link.js";
import { isJsonMode, print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type SourceLinkOptions = {
  repo: string;
  commit: string;
  path: string;
  gitlabOrigin?: string;
  gitlabVersion?: string;
};

function configureSourceLinkCommand(command: Command): void {
  command
    .requiredOption("--repo <url>", "credential-free binding repository URL")
    .requiredOption("--commit <sha>", "complete commit SHA at which the node was read")
    .requiredOption("--path <path>", "Tree-root-relative source file path")
    .option("--gitlab-origin <origin>", "verified GitLab web origin for this binding")
    .option("--gitlab-version <version>", "verified instance version; otherwise query it with local glab");
}

export function runTreeSourceLinkCommand(context: CommandContext): void {
  const options = context.command.opts<SourceLinkOptions>();
  const result = resolveContextTreeSourceLink({
    repoUrl: options.repo,
    commit: options.commit,
    nodePath: options.path,
    gitlabInstanceOrigin: options.gitlabOrigin,
    gitlabVersion: options.gitlabVersion,
  });
  if (context.options.json || isJsonMode()) {
    print.result(result);
  } else {
    print.line(result.url);
  }
}

export const treeSourceLinkCommand: SubcommandModule = {
  name: "source-link",
  alias: "",
  summary: "",
  description: "Build an exact-commit Context Tree citation for the bound forge.",
  configure: configureSourceLinkCommand,
  action: runTreeSourceLinkCommand,
};
