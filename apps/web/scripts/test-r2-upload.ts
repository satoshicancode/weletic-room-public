import { storage } from "@/lib/storage";
import "dotenv-flow/config";

async function main() {
  console.log("Testing Cloudflare R2 upload with raw Buffer...");
  console.log("STORAGE_ENDPOINT:", process.env.STORAGE_ENDPOINT);
  console.log("STORAGE_BASE_URL:", process.env.STORAGE_BASE_URL);
  console.log("STORAGE_PUBLIC_BUCKET:", process.env.STORAGE_PUBLIC_BUCKET);

  const testKey = `program-logos/test_logo_${Date.now()}.png`;
  // 1x1 transparent PNG buffer
  const pngBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAA=",
    "base64",
  );

  try {
    const result = await storage.upload({
      key: testKey,
      body: pngBuffer,
      opts: { contentType: "image/png" },
    });

    console.log("BUFFER_UPLOAD_SUCCESSFUL:", result);

    // Clean up
    await storage.delete({ key: testKey });
    console.log("DELETE_SUCCESSFUL");
    console.log("🎉 BUFFER_UPLOAD_TO_R2_VERIFIED_100%_WORKING");
  } catch (error) {
    console.error("R2 Buffer upload test failed:", error);
    process.exit(1);
  }
}

main();
