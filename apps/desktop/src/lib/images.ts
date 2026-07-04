// Image attachment encoding for the composer (HOY-205). Files are read in the
// renderer and base64-encoded in memory; nothing touches disk. The base64 is raw
// (no data: URI prefix), matching Pi's ImageContent.data.

import type { ImageAttachment } from "./types";
import { shortId } from "./utils";

const attachmentId = () => shortId("img");

// btoa over the whole binary string blows the call stack on large images, so
// chunk the byte array through String.fromCharCode.
export function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  const mimeType = file.type || "image/png";
  const data = base64FromArrayBuffer(await file.arrayBuffer());
  return {
    id: attachmentId(),
    name: file.name,
    mimeType,
    previewUrl: URL.createObjectURL(file),
    content: { type: "image", data, mimeType },
  };
}
