import { describe, expect, it } from "vitest";
import {
  buildLoginCommand,
  buildPortableBootstrapCommand,
  CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
  materializeConnectBootstrapCommand,
  portableCliExecutable,
} from "../connect-bootstrap.js";

describe("connect bootstrap commands", () => {
  it("resolves channel binaries under the portable install directory", () => {
    expect(portableCliExecutable("first-tree-staging")).toBe("~/.local/bin/first-tree-staging");
    expect(portableCliExecutable("first-tree")).toBe("~/.local/bin/first-tree");
  });

  it("builds the default hosted portable bootstrap", () => {
    expect(
      buildPortableBootstrapCommand({
        installerUrl: "https://download.first-tree.ai/releases/staging/install.sh",
        portableDownloadBaseUrl: "https://download.first-tree.ai/releases",
        defaultPortableDownloadBaseUrl: "https://download.first-tree.ai/releases",
        binName: "first-tree-staging",
        token: "FT-CODE",
        serverUrl: "https://dev.cloud.first-tree.ai",
        defaultServerUrl: "https://dev.cloud.first-tree.ai",
      }),
    ).toBe(
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh\n" +
        "~/.local/bin/first-tree-staging login FT-CODE",
    );
  });

  it("quotes custom deployment authority inputs", () => {
    expect(
      buildPortableBootstrapCommand({
        installerUrl: "https://downloads.example.test/releases/$(id)/staging/install.sh",
        portableDownloadBaseUrl: "https://downloads.example.test/releases/$(id)",
        defaultPortableDownloadBaseUrl: "https://download.first-tree.ai/releases",
        binName: "first-tree-staging",
        token: "FT-CODE",
        serverUrl: "https://preview.example.test/path",
        defaultServerUrl: "https://dev.cloud.first-tree.ai",
      }),
    ).toBe(
      "curl -fsSL --proto '=https' --proto-redir '=https' 'https://downloads.example.test/releases/$(id)/staging/install.sh' | " +
        "FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL='https://downloads.example.test/releases/$(id)' sh\n" +
        "FIRST_TREE_SERVER_URL='https://preview.example.test' ~/.local/bin/first-tree-staging login FT-CODE",
    );
  });

  it("keeps login token arguments shell-safe", () => {
    expect(
      buildLoginCommand({
        executable: "first-tree",
        tokenArg: "FT-X; echo injected",
        serverUrl: "https://cloud.first-tree.ai",
        defaultServerUrl: "https://cloud.first-tree.ai",
      }),
    ).toBe("first-tree login 'FT-X; echo injected'");
  });

  it("normalizes repeated trailing slashes in linear time", () => {
    const trailingSlashes = "/".repeat(10_000);
    expect(
      buildLoginCommand({
        executable: "first-tree-dev",
        tokenArg: "FT-CODE",
        serverUrl: `local-server${trailingSlashes}`,
        defaultServerUrl: "local-server",
      }),
    ).toBe("first-tree-dev login FT-CODE");
    expect(
      buildPortableBootstrapCommand({
        installerUrl: "https://download.first-tree.ai/releases/staging/install.sh",
        portableDownloadBaseUrl: `https://download.first-tree.ai/releases${trailingSlashes}`,
        defaultPortableDownloadBaseUrl: "https://download.first-tree.ai/releases",
        binName: "first-tree-staging",
        token: "FT-CODE",
        serverUrl: "https://dev.cloud.first-tree.ai",
        defaultServerUrl: "https://dev.cloud.first-tree.ai",
      }),
    ).toBe(
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh\n" +
        "~/.local/bin/first-tree-staging login FT-CODE",
    );
  });

  it("materializes only a single server-authored placeholder", () => {
    const template = {
      command: `first-tree-staging login ${CONNECT_BOOTSTRAP_CODE_PLACEHOLDER}`,
      codePlaceholder: CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
    } as const;
    expect(materializeConnectBootstrapCommand(template, "FT-PREVIEW-STAGING-ADMIN")).toBe(
      "first-tree-staging login FT-PREVIEW-STAGING-ADMIN",
    );
    expect(() => materializeConnectBootstrapCommand(template, "FT-X; echo injected")).toThrow(TypeError);
    expect(() =>
      materializeConnectBootstrapCommand({ ...template, command: "first-tree-staging login" }, "FT-X"),
    ).toThrow(TypeError);
  });
});
