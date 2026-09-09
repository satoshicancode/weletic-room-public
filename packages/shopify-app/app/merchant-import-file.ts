import { HISTORICAL_IMPORT_MAX_SOURCE_BYTES } from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";

/** Read the selected file once. Do not retain its filename or parse shopper rows
 * in the browser; the server derives the preview from these exact bytes.
 */
export async function prepareMerchantImportFile(
  file: Blob,
  format: "csv" | "json",
) {
  if (
    !["csv", "json"].includes(format) ||
    file.size < 1 ||
    file.size > HISTORICAL_IMPORT_MAX_SOURCE_BYTES
  )
    throw new Error("invalid_import_file");
  const buffer = await file.arrayBuffer();
  if (
    buffer.byteLength !== file.size ||
    buffer.byteLength < 1 ||
    buffer.byteLength > HISTORICAL_IMPORT_MAX_SOURCE_BYTES
  )
    throw new Error("invalid_import_file");
  const bytes = new Uint8Array(buffer);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  // Chunk size is divisible by three: only the last block receives padding.
  // Avoid spreading a whole multi-megabyte upload onto the JS call stack.
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
    encoded.push(
      btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24 * 1024))),
    );
  }
  return {
    source: {
      format,
      sha256: [...hash]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    },
    sourceBase64: encoded.join(""),
  };
}
