import { describe, expect, it } from "vitest";
import {
  getAttachmentFilenameError,
  MAX_ATTACHMENT_FILENAME_BYTES,
  MESSAGE_ATTACHMENT_RETENTION_DAYS,
} from "../schemas/attachment.js";

describe("attachment retention contract", () => {
  it("owns a single 14-day policy number interpolated into user-facing copy", () => {
    expect(MESSAGE_ATTACHMENT_RETENTION_DAYS).toBe(14);
    expect(`Cloud message attachments are retained for ${MESSAGE_ATTACHMENT_RETENTION_DAYS} days`).toBe(
      "Cloud message attachments are retained for 14 days",
    );
  });
});

describe("attachment filename contract", () => {
  it("bounds filenames by UTF-8 bytes and rejects invalid Unicode", () => {
    expect(getAttachmentFilenameError("report.txt")).toBeNull();
    expect(getAttachmentFilenameError("文".repeat(MAX_ATTACHMENT_FILENAME_BYTES / 3))).toBeNull();
    expect(getAttachmentFilenameError(";".repeat(MAX_ATTACHMENT_FILENAME_BYTES + 1))).toContain(
      "exceeds maximum length",
    );
    expect(getAttachmentFilenameError("\ud800")).toContain("valid Unicode");
  });
});
