import { describe, expect, test } from "bun:test";
import { base64FromArrayBuffer, fileToImageAttachment } from "@/lib/images";
import { modelSupportsImages } from "@/lib/types";
import type { ModelInfo } from "@/lib/types";

describe("base64FromArrayBuffer", () => {
  test("encodes bytes without a data: prefix", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const b64 = base64FromArrayBuffer(bytes.buffer);
    expect(b64).not.toContain("data:");
    expect(b64).toBe(btoa(String.fromCharCode(...bytes)));
  });
});

describe("fileToImageAttachment", () => {
  test("produces raw base64 and preserves the mime type", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const attachment = await fileToImageAttachment(file);

    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.content.type).toBe("image");
    expect(attachment.content.mimeType).toBe("image/png");
    expect(attachment.content.data).not.toContain("data:");
    expect(attachment.content.data).toBe(base64FromArrayBuffer(bytes.buffer));
    expect(attachment.name).toBe("shot.png");
  });

  test("falls back to image/png when the file has no type", async () => {
    const file = new File([new Uint8Array([1])], "blob");
    const attachment = await fileToImageAttachment(file);
    expect(attachment.mimeType).toBe("image/png");
  });
});

describe("modelSupportsImages (HOY-205 gating)", () => {
  const model = (input?: string[] | null): ModelInfo => ({
    id: "m",
    name: "M",
    provider: "p",
    input,
  });

  test("true when input includes image", () => {
    expect(modelSupportsImages(model(["text", "image"]))).toBe(true);
  });

  test("false when input is present but lacks image", () => {
    expect(modelSupportsImages(model(["text"]))).toBe(false);
  });

  test("fail soft: true when input is missing or model is null", () => {
    expect(modelSupportsImages(model(null))).toBe(true);
    expect(modelSupportsImages(model(undefined))).toBe(true);
    expect(modelSupportsImages(null)).toBe(true);
  });
});
