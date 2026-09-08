import { withWorkspace } from "@/lib/auth";
import { storage } from "@/lib/storage";
import { nanoid, R2_URL } from "@dub/utils";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const schema = z.object({
  folder: z.enum(["integration-screenshots", "program-logos"]),
});

// POST /api/workspaces/[idOrSlug]/upload-url – get a signed URL or upload a file directly
export const POST = withWorkspace(
  async ({ req }) => {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const folder = (formData.get("folder") as string) || "program-logos";

      if (!file) {
        return NextResponse.json(
          { error: "File is required" },
          { status: 400 },
        );
      }

      const key = `${folder}/${nanoid(16)}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      const { url } = await storage.upload({
        key,
        body: buffer,
        opts: { contentType: file.type || "image/png" },
      });

      return NextResponse.json({
        key,
        signedUrl: url,
        destinationUrl: url,
      });
    }

    const { folder } = schema.parse(await req.json());

    const key = `${folder}/${nanoid(16)}`;
    const signedUrl = await storage.getSignedUploadUrl({
      key,
    });

    return NextResponse.json({
      key,
      signedUrl,
      destinationUrl: `${(process.env.STORAGE_BASE_URL || R2_URL).replace(/\/$/, "")}/${key}`,
    });
  },
  {
    requiredRoles: ["owner", "member"],
  },
);
