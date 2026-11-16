import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CAPABILITIES = { codex: { state: "ok", available: true } };

const clientMocks = vi.hoisted(() => ({ probeCapabilities: vi.fn() }));
const coreMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  ensureFreshBoundAccessToken: vi.fn(),
  loadCredentials: vi.fn(),
  printResults: vi.fn(),
  runtimeProviderChecks: vi.fn(() => [{ label: "codex", ok: true, detail: "ok" }]),
  uploadClientCapabilities: vi.fn(),
}));
const outputMocks = vi.hoisted(() => ({
  isJsonMode: vi.fn(() => false),
  print: { result: vi.fn(), line: vi.fn(), status: vi.fn() },
}));
const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
);
const configMocks = vi.hoisted(() => ({
  clientConfigSchema: {},
  initConfig: vi.fn(),
  resetConfig: vi.fn(),
  resetConfigMeta: vi.fn(),
}));

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("../core/index.js", () => coreMocks);
vi.mock("../core/output.js", () => outputMocks);
vi.mock("../cli/output.js", () => ({ fail: failMock }));
vi.mock("../core/channel.js", () => ({ channelConfig: { binName: "first-tree-test" } }));
vi.mock("@first-tree/shared/config", () => configMocks);

async function runProbe(args: string[]): Promise<void> {
  const { registerDaemonProbeCommand } = await import("../commands/daemon/probe.js");
  const daemon = new Command();
  registerDaemonProbeCommand(daemon);
  await daemon.parseAsync(["probe", ...args], { from: "user" });
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.probeCapabilities.mockResolvedValue(CAPABILITIES);
  coreMocks.loadCredentials.mockReturnValue(true);
  coreMocks.ensureFreshAccessToken.mockResolvedValue("token");
  coreMocks.ensureFreshBoundAccessToken.mockResolvedValue({ token: "token", origin: "https://hub" });
  coreMocks.uploadClientCapabilities.mockResolvedValue(undefined);
  configMocks.initConfig.mockResolvedValue({ server: { url: "https://hub" }, client: { id: "client-1" } });
  outputMocks.isJsonMode.mockReturnValue(false);
});

afterEach(() => {
  vi.resetModules();
});

describe("daemon probe", () => {
  it("default run: probes, renders human report, and uploads", async () => {
    await runProbe([]);
    expect(clientMocks.probeCapabilities).toHaveBeenCalledTimes(1);
    expect(coreMocks.printResults).toHaveBeenCalledTimes(1);
    expect(outputMocks.print.result).not.toHaveBeenCalled();
    expect(coreMocks.uploadClientCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-1", capabilities: CAPABILITIES }),
    );
  });

  it("--no-upload is credentials-free local-only: no loadCredentials / initConfig / upload", async () => {
    await runProbe(["--no-upload"]);
    expect(clientMocks.probeCapabilities).toHaveBeenCalledTimes(1);
    expect(coreMocks.printResults).toHaveBeenCalledTimes(1);
    expect(coreMocks.loadCredentials).not.toHaveBeenCalled();
    expect(configMocks.initConfig).not.toHaveBeenCalled();
    expect(coreMocks.uploadClientCapabilities).not.toHaveBeenCalled();
  });

  it("--json emits the machine envelope via print.result (stdout), not the human report", async () => {
    await runProbe(["--json"]);
    expect(outputMocks.print.result).toHaveBeenCalledWith(CAPABILITIES);
    expect(coreMocks.printResults).not.toHaveBeenCalled();
    // still uploads by default
    expect(coreMocks.uploadClientCapabilities).toHaveBeenCalledTimes(1);
  });

  it("global --json mode (isJsonMode) also emits via print.result", async () => {
    outputMocks.isJsonMode.mockReturnValue(true);
    await runProbe([]);
    expect(outputMocks.print.result).toHaveBeenCalledWith(CAPABILITIES);
    expect(coreMocks.printResults).not.toHaveBeenCalled();
  });

  it("--json --no-upload emits the envelope and skips upload + credentials", async () => {
    await runProbe(["--json", "--no-upload"]);
    expect(outputMocks.print.result).toHaveBeenCalledWith(CAPABILITIES);
    expect(coreMocks.loadCredentials).not.toHaveBeenCalled();
    expect(coreMocks.uploadClientCapabilities).not.toHaveBeenCalled();
  });

  it("default run without credentials fails closed with NO_CREDENTIALS", async () => {
    coreMocks.loadCredentials.mockReturnValue(false);
    await expect(runProbe([])).rejects.toMatchObject({ code: "NO_CREDENTIALS" });
    // probe + local render happened before the upload-gate credentials check
    expect(clientMocks.probeCapabilities).toHaveBeenCalledTimes(1);
    expect(coreMocks.uploadClientCapabilities).not.toHaveBeenCalled();
  });

  it("--json without credentials does NOT emit a premature success envelope (fails NO_CREDENTIALS)", async () => {
    coreMocks.loadCredentials.mockReturnValue(false);
    await expect(runProbe(["--json"])).rejects.toMatchObject({ code: "NO_CREDENTIALS" });
    // the {ok:true} envelope must not be written before the upload outcome is known
    expect(outputMocks.print.result).not.toHaveBeenCalled();
    expect(coreMocks.uploadClientCapabilities).not.toHaveBeenCalled();
  });

  it("--json with a failed upload emits an error envelope, never a success one", async () => {
    coreMocks.uploadClientCapabilities.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(runProbe(["--json"])).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(outputMocks.print.result).not.toHaveBeenCalled();
  });

  it("stringifies non-Error upload failures in JSON and human modes", async () => {
    coreMocks.uploadClientCapabilities.mockRejectedValueOnce("upload string failure");
    await expect(runProbe(["--json"])).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(failMock).toHaveBeenLastCalledWith("UPLOAD_FAILED", "upload string failure", 1);

    coreMocks.uploadClientCapabilities.mockRejectedValueOnce("soft upload string failure");
    await runProbe([]);
    expect(outputMocks.print.status).toHaveBeenLastCalledWith(
      "⚠️",
      "capabilities upload skipped: soft upload string failure",
    );
  });

  it("--json success envelope is emitted only after a successful upload", async () => {
    await runProbe(["--json"]);
    expect(coreMocks.uploadClientCapabilities).toHaveBeenCalledTimes(1);
    expect(outputMocks.print.result).toHaveBeenCalledWith(CAPABILITIES);
    const uploadOrder = coreMocks.uploadClientCapabilities.mock.invocationCallOrder[0];
    const resultOrder = outputMocks.print.result.mock.invocationCallOrder[0];
    expect(resultOrder).toBeGreaterThan(uploadOrder); // envelope after upload
  });
});
