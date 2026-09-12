import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { prepareMerchantImportFile } from "../../../../packages/shopify-app/app/merchant-import-file";
it.each([1, 2, 3, 24575, 24576, 24577, 49154])(
  "preserves exactly %s bytes across base64 blocks",
  async (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
    const result = await prepareMerchantImportFile(new Blob([bytes]), "csv");
    expect(result.sourceBase64).toBe(Buffer.from(bytes).toString("base64"));
    expect(result.source.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.source.format).toBe("csv");
    expect(Object.keys(result)).toEqual(["source", "sourceBase64"]);
  },
);
it("rejects an oversized file before reading it", async () => {
  const read = vi.fn();
  await expect(
    prepareMerchantImportFile(
      { size: 10 * 1024 * 1024 + 1, arrayBuffer: read } as unknown as Blob,
      "json",
    ),
  ).rejects.toThrow("invalid_import_file");
  expect(read).not.toHaveBeenCalled();
});
it("rejects empty files and mismatched size claims", async () => {
  await expect(prepareMerchantImportFile(new Blob([]), "csv")).rejects.toThrow(
    "invalid_import_file",
  );
  await expect(
    prepareMerchantImportFile(
      { size: 1, arrayBuffer: async () => new ArrayBuffer(2) } as Blob,
      "csv",
    ),
  ).rejects.toThrow("invalid_import_file");
});
