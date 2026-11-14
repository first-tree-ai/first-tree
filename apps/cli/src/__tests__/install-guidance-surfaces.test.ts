import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockChannelConfig = {
  channel: "dev" | "staging" | "prod";
  binName: string;
  portable: {
    downloadBaseUrl: string | null;
    publicInstallerPath: string | null;
  };
};

const mocks = vi.hoisted(() => {
  const channelConfig: MockChannelConfig = {
    channel: "prod",
    binName: "first-tree",
    portable: {
      downloadBaseUrl: "https://download.first-tree.ai/releases",
      publicInstallerPath: "prod/install.sh",
    },
  };
  return {
    channelConfig,
    detectInstallMode: vi.fn(() => "npx"),
    printLine: vi.fn(),
  };
});

vi.mock("../core/channel.js", () => ({
  get channelConfig() {
    return mocks.channelConfig;
  },
}));

vi.mock("../core/index.js", () => ({
  COMMAND_VERSION: "0.5.0",
  detectInstallMode: mocks.detectInstallMode,
  fetchLatestVersion: vi.fn(),
  fetchPortableLatestVersion: vi.fn(),
  fetchServerCommandVersion: vi.fn(),
  getClientServiceStatus: vi.fn(),
  installClientService: vi.fn(),
  installGlobalLatest: vi.fn(),
  installGlobalSpec: vi.fn(),
  installPortableSpec: vi.fn(),
  isServiceSupported: vi.fn(),
  restartClientService: vi.fn(),
}));

vi.mock("../core/update.js", () => ({
  detectInstallMode: mocks.detectInstallMode,
  fetchServerCommandVersion: vi.fn(),
  installGlobalSpec: vi.fn(),
  installPortableSpec: vi.fn(),
  PACKAGE_NAME: "first-tree",
}));

vi.mock("../core/update-state.js", () => ({
  isLoopGuarded: vi.fn(),
  recordUpdateAttempt: vi.fn(),
}));

vi.mock("../core/output.js", () => ({
  print: { line: mocks.printLine },
}));

import { registerUpgradeCommand } from "../commands/upgrade.js";
import { createExecuteUpdate } from "../core/update-glue.js";

type ChannelCase = {
  channel: "dev" | "staging" | "prod";
  binName: string;
  installerPath: string | null;
  downloadBaseUrl: string | null;
  expected: string;
};

const CASES: ChannelCase[] = [
  {
    channel: "prod",
    binName: "first-tree",
    installerPath: "prod/install.sh",
    downloadBaseUrl: "https://download.first-tree.ai/releases",
    expected:
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh",
  },
  {
    channel: "staging",
    binName: "first-tree-staging",
    installerPath: "staging/install.sh",
    downloadBaseUrl: "https://download.first-tree.ai/releases/",
    expected:
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh",
  },
  {
    channel: "dev",
    binName: "first-tree-dev",
    installerPath: null,
    downloadBaseUrl: null,
    expected: "./scripts/dev-install.sh",
  },
];

async function runUpgrade(): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerUpgradeCommand(program);
  await program.parseAsync(["node", "test", "upgrade"]);
  return mocks.printLine.mock.calls.map((call) => String(call[0])).join("");
}

describe.each(CASES)("$channel channel install guidance", (channelCase) => {
  beforeEach(() => {
    mocks.detectInstallMode.mockReturnValue("npx");
    mocks.printLine.mockClear();
    mocks.channelConfig.channel = channelCase.channel;
    mocks.channelConfig.binName = channelCase.binName;
    mocks.channelConfig.portable.downloadBaseUrl = channelCase.downloadBaseUrl;
    mocks.channelConfig.portable.publicInstallerPath = channelCase.installerPath;
  });

  it("uses the channel install command in the npx upgrade path", async () => {
    const output = await runUpgrade();

    expect(output).toContain(channelCase.expected);
    expect(output).not.toContain("npm i -g");
    expect(output).not.toContain("npm install -g");
  });

  it("uses the channel install command in background update guidance", async () => {
    const log = vi.fn();

    await expect(
      createExecuteUpdate({ managed: false, log })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });

    const output = log.mock.calls.map((call) => String(call[1])).join("");
    expect(output).toContain(channelCase.expected);
    expect(output).not.toContain("npm i -g");
    expect(output).not.toContain("npm install -g");
  });
});
