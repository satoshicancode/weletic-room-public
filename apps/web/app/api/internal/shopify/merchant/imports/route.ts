import { prisma } from "@/lib/prisma";
import {
  historicalImportContextRequestSchema,
  historicalImportExecutionRequestSchema,
  historicalImportHistoryRequestSchema,
  historicalImportReconciliationRequestSchema,
  historicalImportStatusRequestSchema,
} from "@/lib/weletic/loyalty/historical-import-contract";
import { HistoricalImportConflictError } from "@/lib/weletic/loyalty/historical-import-persistence";
import {
  HISTORICAL_IMPORT_MAX_SOURCE_BYTES,
  HistoricalImportSourceError,
} from "@/lib/weletic/loyalty/historical-import-source";
import {
  startShopifyHistoricalImportCommit,
  startShopifyHistoricalImportRollback,
} from "@/lib/weletic/shopify/historical-import-start";
import {
  historicalImportPreparationRequestSchema,
  prepareShopifyHistoricalImportInTransaction,
  readShopifyImportContextInTransaction,
  readShopifyImportHistoryInTransaction,
  readShopifyImportStatusInTransaction,
  reconcileShopifyHistoricalImportInTransaction,
} from "@/lib/weletic/shopify/historical-imports";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { isShopifyStoreOperationalWritesBlocked } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const encodedLimit = Math.ceil(HISTORICAL_IMPORT_MAX_SOURCE_BYTES / 3) * 4;
const uploadBodySchema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    request: historicalImportPreparationRequestSchema,
    sourceBase64: z.string().min(4).max(encodedLimit),
  })
  .strict();
const bodySchema = z.union([
  uploadBodySchema,
  z
    .object({
      actor: shopifyMerchantActorEnvelopeSchema,
      request: z.union([
        historicalImportContextRequestSchema,
        historicalImportStatusRequestSchema,
        historicalImportHistoryRequestSchema,
        historicalImportReconciliationRequestSchema,
        historicalImportExecutionRequestSchema,
      ]),
    })
    .strict(),
]);
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export async function POST(request: Request) {
  try {
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: encodedLimit + 16 * 1024,
    });
    if (bytes === null) return reply({ error: "invalid_request" }, 400);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reply({ error: "unauthorized" }, 401);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return reply({ error: "invalid_request" }, 400);
    }
    const parsed = bodySchema.safeParse(value);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    if (!("sourceBase64" in parsed.data)) {
      if (
        parsed.data.request.operation === "commit" ||
        parsed.data.request.operation === "rollback"
      ) {
        const start =
          parsed.data.request.operation === "commit"
            ? startShopifyHistoricalImportCommit
            : startShopifyHistoricalImportRollback;
        return reply(
          await start({
            envelope: parsed.data.actor,
            request: parsed.data.request,
          }),
          200,
        );
      }
      const result = await prisma.$transaction(
        async (tx) =>
          parsed.data.request.operation === "status"
            ? readShopifyImportStatusInTransaction({
                tx,
                envelope: parsed.data.actor,
                request: parsed.data.request,
              })
            : parsed.data.request.operation === "reconcile"
              ? reconcileShopifyHistoricalImportInTransaction({
                  tx,
                  envelope: parsed.data.actor,
                  request: parsed.data.request,
                })
              : parsed.data.request.operation === "history"
                ? readShopifyImportHistoryInTransaction({
                    tx,
                    envelope: parsed.data.actor,
                    request: parsed.data.request,
                  })
                : readShopifyImportContextInTransaction({
                    tx,
                    envelope: parsed.data.actor,
                  }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      return reply(result, 200);
    }
    const upload = Buffer.from(parsed.data.sourceBase64, "base64");
    // Buffer decoding is permissive: require canonical padding/alphabet and exact
    // round trip, rather than silently accepting whitespace or invalid suffixes.
    if (
      !upload.length ||
      upload.length > HISTORICAL_IMPORT_MAX_SOURCE_BYTES ||
      upload.toString("base64") !== parsed.data.sourceBase64
    )
      return reply({ error: "invalid_request" }, 400);
    const result = await prisma.$transaction(
      (tx) =>
        prepareShopifyHistoricalImportInTransaction({
          tx,
          envelope: parsed.data.actor,
          request: parsed.data.request,
          bytes: upload,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return reply(result, 200);
  } catch (error) {
    if (error instanceof ShopifyStaffAuthorizationError)
      return reply(
        { error: error.code },
        error.code === "access_denied"
          ? 403
          : error.code === "request_replayed"
            ? 409
            : 401,
      );
    if (error instanceof SessionCredentialWriteBlockedError)
      return reply({ error: "invalid_actor" }, 401);
    if (isShopifyStoreOperationalWritesBlocked(error))
      return reply({ error: "access_denied" }, 403);
    if (error instanceof HistoricalImportSourceError)
      return reply({ error: "invalid_source" }, 400);
    if (
      error instanceof HistoricalImportConflictError ||
      error instanceof ShopifySessionCoordinationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2034", "P2002"].includes(error.code))
    )
      return reply({ error: "state_changed" }, 409);
    return reply({ error: "imports_unavailable" }, 503);
  }
}
