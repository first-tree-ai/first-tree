import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FirstTreeHubSDK } from "@first-tree/client";
import type { ImageRefContent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutboundImages, toGenericImageAttachmentRefs } from "../core/image-capture.js";

/**
 * `chat send` image capture: the picture sibling of doc capture. Driven by the
 * same runtime-injected fence env; uploads bytes to the org store (org from the
 * chat) and returns image refs + the image-stripped caption. The scan/strip
 * mechanics are covered by client `image-snapshots.test.ts`; these tests pin the
 * env contract + the org resolution this layer owns.
 */

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubSdk(overrides?: { org?: string | null }): { sdk: FirstTreeHubSDK } {
  let seq = 0;
  const sdk = {
    serverUrl: "http://test",
    async getChatDetail() {
      return { id: CHAT_ID, organizationId: overrides?.org === undefined ? ORG_ID : overrides.org, participants: [] };
    },
    async uploadAttachment(o: { bytes: Uint8Array | Buffer; mimeType: string; filename: string; orgId: string }) {
      seq += 1;
      const bytes = Buffer.from(o.bytes);
      return {
        id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
        mimeType: o.mimeType,
        filename: o.filename,
        sizeBytes: bytes.byteLength,
      };
    },
  } as unknown as FirstTreeHubSDK;
  return { sdk };
}

describe("captureOutboundImages (chat send image capture)", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cli-img-capture-"));
    await writeFile(join(base, "shot.png"), PNG);
    const repoBase = join(base, "source-repos", "first-tree");
    await mkdir(repoBase, { recursive: true });
    await writeFile(join(repoBase, "shot.png"), Buffer.concat([PNG, Buffer.from("repo-copy")]));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("pass-through when no fence base in env (not in an agent session)", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundImages("![s](shot.png)", { sdk, chatId: CHAT_ID }, {});
    expect(out.imageRefs).toHaveLength(0);
    expect(out.caption).toBe("![s](shot.png)");
  });

  it("pass-through when no chatId is supplied (org unresolvable, e.g. chat create)", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundImages("![s](shot.png)", { sdk }, { FIRST_TREE_DOC_BASE: base });
    expect(out.imageRefs).toHaveLength(0);
    expect(out.caption).toBe("![s](shot.png)");
  });

  it("pass-through when the chat has no resolvable org", async () => {
    const { sdk } = stubSdk({ org: null });
    const out = await captureOutboundImages("![s](shot.png)", { sdk, chatId: CHAT_ID }, { FIRST_TREE_DOC_BASE: base });
    expect(out.imageRefs).toHaveLength(0);
  });

  it("captures the image and returns the stripped caption when the fence resolves", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundImages(
      "看图：\n\n![shot](shot.png)",
      { sdk, chatId: CHAT_ID },
      { FIRST_TREE_DOC_BASE: base },
    );
    expect(out.imageRefs).toHaveLength(1);
    expect(out.imageRefs[0]).toMatchObject({ mimeType: "image/png", filename: "shot.png" });
    expect(out.caption).toBe("看图：");
  });

  it("resolves relative images from the agent workspace even when documents use a repo base", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundImages(
      "看图：\n\n![shot](shot.png)",
      { sdk, chatId: CHAT_ID },
      {
        FIRST_TREE_DOC_AGENT_HOME: base,
        FIRST_TREE_DOC_BASE: join(base, "source-repos", "first-tree"),
        FIRST_TREE_DOC_REPO_LOCAL_PATH: "source-repos/first-tree",
      },
    );
    expect(out.imageRefs).toHaveLength(1);
    expect(out.imageRefs[0]).toMatchObject({ filename: "shot.png", size: PNG.byteLength });
    expect(out.caption).toBe("看图：");
  });
});

describe("toGenericImageAttachmentRefs (metadata attachments)", () => {
  const ref: ImageRefContent = {
    imageId: "00000000-0000-4000-8000-000000000001",
    mimeType: "image/png",
    filename: "shot.png",
    size: 8,
  };

  it("adapts captured image refs into generic metadata attachments", () => {
    expect(toGenericImageAttachmentRefs([ref])).toEqual([
      {
        attachmentId: ref.imageId,
        kind: "image",
        mimeType: "image/png",
        filename: "shot.png",
        size: 8,
      },
    ]);
    expect(toGenericImageAttachmentRefs([{ ...ref, size: undefined }])).toEqual([]);
  });
});
