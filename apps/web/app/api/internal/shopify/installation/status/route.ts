import { prisma } from "@/lib/prisma";
import { readInstallationAdmissionStatus } from "@/lib/weletic/shopify/installation-admission";
import { installationStatusIdentitySchema } from "@/lib/weletic/shopify/installation-admission-contract";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
function reply(value: unknown, status: number) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  if (request.method !== "POST")
    return reply({ error: "method_not_allowed" }, 405);
  try {
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 4096,
    });
    if (bytes === null) return reply({ error: "invalid_request" }, 400);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reply({ error: "unauthorized" }, 401);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return reply({ error: "invalid_request" }, 400);
    }
    const parsed = installationStatusIdentitySchema.safeParse(input);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const status = await prisma.$transaction((tx) =>
      readInstallationAdmissionStatus(tx, parsed.data),
    );
    return reply(status, 200);
  } catch {
    return reply({ error: "status_unavailable" }, 503);
  }
}
