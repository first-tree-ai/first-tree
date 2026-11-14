import { describe, expect, it } from "vitest";
import { connectTokenResponseSchema } from "../schemas/auth.js";

const baseResponse = {
  token: "connect-token",
  expiresIn: 600,
  command: "first-tree login abc",
  bootstrapCommand: "curl -fsSL https://downloads.example.test/prod/install.sh | sh\nfirst-tree login abc",
  installerUrl: "https://downloads.example.test/prod/install.sh",
  binName: "first-tree",
};

describe("connectTokenResponseSchema", () => {
  it("exposes only the channel-aware shell bootstrap fields", () => {
    expect(Object.keys(connectTokenResponseSchema.shape)).toEqual([
      "token",
      "expiresIn",
      "command",
      "bootstrapCommand",
      "installerUrl",
      "binName",
    ]);
  });

  it("rejects a plaintext installer URL outside loopback", () => {
    // SEC-025: the URL is rendered into `curl … | sh`, so a mirrored or older
    // deployment must not be able to hand clients a plaintext download.
    expect(() =>
      connectTokenResponseSchema.parse({
        ...baseResponse,
        installerUrl: "http://downloads.example.test/prod/install.sh",
      }),
    ).toThrow(/https/iu);
  });

  it("still accepts https and a loopback http installer URL", () => {
    expect(connectTokenResponseSchema.parse(baseResponse).installerUrl).toBe(baseResponse.installerUrl);
    expect(
      connectTokenResponseSchema.parse({ ...baseResponse, installerUrl: "http://127.0.0.1:8000/prod/install.sh" })
        .installerUrl,
    ).toBe("http://127.0.0.1:8000/prod/install.sh");
    expect(connectTokenResponseSchema.parse({ ...baseResponse, installerUrl: null }).installerUrl).toBeNull();
  });
});
