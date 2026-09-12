import { prisma } from "@/lib/prisma";
import { installationStatusIdentitySchema } from "@/lib/weletic/shopify/installation-admission-contract";
import {
  installationReconnectObservationSchema,
  observePendingInstallationReconnect,
  preparePendingInstallationReconnect,
} from "@/lib/weletic/shopify/installation-reconnect";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";
const inputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("observe"),
      identity: installationStatusIdentitySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("prepare"),
      identity: installationStatusIdentitySchema,
      observation: installationReconnectObservationSchema,
    })
    .strict(),
]);
const reply = (value: unknown, status: number) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function POST(request: Request) {
  try {
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 4096,
    });
    if (!bytes) return reply({ error: "invalid_request" }, 400);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reply({ error: "unauthorized" }, 401);
    let input;
    try {
      input = inputSchema.parse(JSON.parse(body));
    } catch {
      return reply({ error: "invalid_request" }, 400);
    }
    const result = await prisma.$transaction(async (tx) =>
      input.operation === "observe"
        ? observePendingInstallationReconnect(tx, input.identity)
        : preparePendingInstallationReconnect(
            tx,
            input.identity,
            input.observation,
          ),
    );
    return reply(result, 200);
  } catch {
    return reply({ error: "reconnect_unavailable" }, 503);
  }
}
