import { createHmac } from "node:crypto";

/** Non-authorizing object metadata. Never send the raw attempt token, shopper
 * identity or content digest to R2 metadata. The retained random attempt token
 * lets privacy recovery verify completion even after content hashes are erased.
 */
export function openPhotoUploadProof(
  storeId: string,
  mediaId: string,
  token: string,
) {
  if (!/^[0-9a-f]{64}$/.test(token))
    throw new Error("Invalid photo write token");
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(JSON.stringify(["weletic-open-photo-write-v1", storeId, mediaId]))
    .digest("hex");
}
