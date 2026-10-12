/// <reference types="@cloudflare/workers-types" />
import {
  resolveShopifyStoreByDomain,
  type ResolvedShopifyStore,
} from "../../../lib/weletic/shopify/store-resolver";
import { recordWeleticOrder } from "../../../lib/weletic/commerce/record-order";
import { recordWeleticRefund } from "../../../lib/weletic/commerce/record-refund";
import {
  prisma,
  createPrismaClient,
  type ExtendedPrismaClient,
} from "../../../lib/prisma";
import type {
  WebhookQueueMessage,
  QueueSender,
} from "../../webhook-ingress/src/index";

export interface QueueMessageItem<T = any> {
  readonly id?: string;
  readonly timestamp?: Date | number;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<T = any> {
  readonly queue?: string;
  readonly messages: readonly QueueMessageItem<T>[];
  ackAll?(): void;
  retryAll?(options?: { delaySeconds?: number }): void;
}

export interface QueueConsumerEnv {
  DB?: D1Database;
  ORDER_WEBHOOK_QUEUE?: QueueSender<WebhookQueueMessage>;
  ORDER_WEBHOOK_DLQ?: QueueSender<any>;
  SHOPIFY_WEBHOOK_SECRET?: string;
}

export interface DLQMessagePayload {
  webhookId: string;
  topic: string;
  shopDomain: string;
  rawPayload: string;
  attempts: number;
  error: string;
  failedAt: number;
}

export function extractOrderDiscountCodes(event: any): string[] {
  const discountCodes = Array.isArray(event?.discount_codes)
    ? event.discount_codes
    : [];
  const discountApplications = Array.isArray(event?.discount_applications)
    ? event.discount_applications
    : [];

  return Array.from(
    new Set(
      [...discountCodes, ...discountApplications]
        .map((discount: any) => {
          const candidate =
            discount?.code ||
            (discount?.type === "discount_code" ? discount?.title : "");
          return candidate ? String(candidate).trim().toUpperCase() : "";
        })
        .filter(Boolean),
    ),
  );
}

/**
 * Invariant 2 & Historical Attribution (FIN-AUDIT-05 / WRK-AUDIT-06):
 * If orderCreatedAt is provided, allows attribution for codes that were active at checkout
 * (orderCreatedAt <= disabledAt). If omitted, strictly requires disabledAt: null (Invariant 2).
 */
export async function findActiveDiscountCode(
  prismaClient: typeof prisma,
  programId: string,
  code: string,
  orderCreatedAt?: Date | string | null,
) {
  // If no order timestamp is specified, strictly enforce Invariant 2 (active only)
  if (!orderCreatedAt) {
    return prismaClient.discountCode.findFirst({
      where: {
        programId,
        code,
        disabledAt: null,
      },
      include: {
        link: true,
      },
    });
  }

  const orderDate =
    orderCreatedAt instanceof Date ? orderCreatedAt : new Date(orderCreatedAt);
  const isOrderDateValid = !isNaN(orderDate.getTime());

  // Fail-closed: invalid order timestamp cannot claim disabled discounts
  if (!isOrderDateValid) {
    return prismaClient.discountCode.findFirst({
      where: {
        programId,
        code,
        disabledAt: null,
      },
      include: {
        link: true,
      },
    });
  }

  // Historical attribution: active now OR disabled AFTER order was placed
  return prismaClient.discountCode.findFirst({
    where: {
      programId,
      code,
      OR: [
        { disabledAt: null },
        { disabledAt: { gte: orderDate } },
      ],
    },
    include: {
      link: true,
    },
  });
}

async function checkWebhookIdempotency(
  env: QueueConsumerEnv,
  prismaClient: typeof prisma,
  webhookId: string,
): Promise<{ isDuplicate: boolean; existingRecord?: any }> {
  if (env.DB?.prepare) {
    const row = await env.DB.prepare(
      "SELECT id, status, attempts FROM WeleticShopifyWebhookEvent WHERE webhookId = ?",
    )
      .bind(webhookId)
      .first<{ id: string; status: string; attempts: number }>();

    if (row && (row.status === "completed" || row.status === "processed")) {
      return { isDuplicate: true, existingRecord: row };
    }
    return { isDuplicate: false, existingRecord: row };
  }

  const record = await prismaClient.weleticShopifyWebhookEvent.findUnique({
    where: { webhookId },
    select: { id: true, status: true, attempts: true },
  });

  if (
    record &&
    (record.status === "processed" || (record.status as string) === "completed")
  ) {
    return { isDuplicate: true, existingRecord: record };
  }
  return { isDuplicate: false, existingRecord: record };
}

async function markWebhookCompleted(
  env: QueueConsumerEnv,
  prismaClient: typeof prisma,
  params: {
    webhookId: string;
    storeId: string;
    topic: string;
    attempts: number;
    payload?: any;
  },
) {
  const eventId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "whook_" + Math.random().toString(36).substring(2);

  const nowIso = new Date().toISOString();
  if (env.DB?.prepare) {
    await env.DB.prepare(
      "INSERT INTO WeleticShopifyWebhookEvent (id, storeId, webhookId, topic, status, attempts, processedAt, updatedAt) " +
        "VALUES (?, ?, ?, ?, 'completed', ?, ?, ?) " +
        "ON CONFLICT(webhookId) DO UPDATE SET status = 'completed', attempts = excluded.attempts, processedAt = excluded.processedAt, updatedAt = excluded.updatedAt",
    )
      .bind(
        eventId,
        params.storeId,
        params.webhookId,
        params.topic,
        params.attempts,
        nowIso,
        nowIso,
      )
      .run();
    return;
  }

  await prismaClient.weleticShopifyWebhookEvent.upsert({
    where: { webhookId: params.webhookId },
    create: {
      id: eventId,
      storeId: params.storeId,
      webhookId: params.webhookId,
      topic: params.topic,
      status: "completed",
      attempts: params.attempts,
      processedAt: new Date(),
    },
    update: {
      status: "completed",
      attempts: params.attempts,
      processedAt: new Date(),
    },
  });
}

async function recordWebhookFailure(
  env: QueueConsumerEnv,
  prismaClient: typeof prisma,
  params: {
    webhookId: string;
    storeId: string;
    topic: string;
    attempts: number;
    error: string;
  },
) {
  const eventId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "whook_" + Math.random().toString(36).substring(2);

  const nowIso = new Date().toISOString();
  if (env.DB?.prepare) {
    await env.DB.prepare(
      "INSERT INTO WeleticShopifyWebhookEvent (id, storeId, webhookId, topic, status, error, attempts, updatedAt) " +
        "VALUES (?, ?, ?, ?, 'failed', ?, ?, ?) " +
        "ON CONFLICT(webhookId) DO UPDATE SET status = 'failed', error = excluded.error, attempts = excluded.attempts, updatedAt = excluded.updatedAt",
    )
      .bind(
        eventId,
        params.storeId,
        params.webhookId,
        params.topic,
        params.error,
        params.attempts,
        nowIso,
      )
      .run();
    return;
  }

  await prismaClient.weleticShopifyWebhookEvent.upsert({
    where: { webhookId: params.webhookId },
    create: {
      id: eventId,
      storeId: params.storeId,
      webhookId: params.webhookId,
      topic: params.topic,
      status: "failed",
      error: params.error,
      attempts: params.attempts,
    },
    update: {
      status: "failed",
      error: params.error,
      attempts: params.attempts,
    },
  });
}

async function dispatchTopic(
  topic: string,
  event: any,
  store: ResolvedShopifyStore,
  prismaClient: typeof prisma,
) {
  if (topic === "orders/paid") {
    // Check for discount codes and active partner attribution (Invariant 2 & Historical Attribution)
    const codes = extractOrderDiscountCodes(event);
    let partnerId: string | null = null;
    let linkId: string | null = null;

    const orderCreatedAt = event.created_at ?? event.processed_at ?? null;

    if (codes.length > 0 && store.programId) {
      for (const code of codes) {
        const activeDiscount = await findActiveDiscountCode(
          prismaClient,
          store.programId,
          code,
          orderCreatedAt,
        );
        if (activeDiscount) {
          partnerId = activeDiscount.partnerId;

          // Check if attached link was disabled prior to order placement
          let link = activeDiscount.link;
          if (link?.disabledAt && orderCreatedAt) {
            const orderDate = new Date(orderCreatedAt);
            const linkDisabledDate = new Date(link.disabledAt);
            if (
              !isNaN(orderDate.getTime()) &&
              !isNaN(linkDisabledDate.getTime()) &&
              orderDate > linkDisabledDate
            ) {
              link = null; // Let recordWeleticOrder resolve fallback link
            }
          }
          linkId = link ? activeDiscount.linkId : null;
          break;
        }
      }
    }

    // Fallback: Repeat affiliate customer attribution if no coupon matched
    if (!partnerId && event.customer?.id && store.workspaceId) {
      const existingCustomer = await prismaClient.customer.findUnique({
        where: {
          projectId_externalId: {
            projectId: store.workspaceId,
            externalId: String(event.customer.id),
          },
        },
        include: { link: true },
      });
      if (existingCustomer) {
        partnerId =
          existingCustomer.partnerId ??
          existingCustomer.link?.partnerId ??
          null;
        linkId = existingCustomer.linkId ?? null;
      }
    }

    await recordWeleticOrder({
      event,
      workspaceId: store.workspaceId,
      programId: store.programId,
      storeId: store.storeId,
      partnerId,
      linkId,
    });
  } else if (topic === "refunds/create") {
    await recordWeleticRefund({
      event,
      workspaceId: store.workspaceId,
    });
  } else if (topic === "app/uninstalled") {
    await prismaClient.weleticShopifyStore.updateMany({
      where: {
        OR: [
          { id: store.storeId || store.shopId },
          { shopDomain: store.myshopifyDomain },
        ],
      },
      data: {
        complianceState: "uninstalled",
        uninstalledAt: new Date(),
      },
    });
  }
}

export function initQueueConsumerPrisma(env: QueueConsumerEnv): ExtendedPrismaClient {
  if (env.DB) {
    (globalThis as any).DB = env.DB;
    if (!(globalThis as any).prisma || (globalThis as any).__boundD1 !== env.DB) {
      (globalThis as any).prisma = createPrismaClient(env.DB);
      (globalThis as any).__boundD1 = env.DB;
    }
    return (globalThis as any).prisma;
  }
  return (globalThis as any).prisma ?? prisma;
}

export async function processQueueMessage(
  msg: QueueMessageItem<WebhookQueueMessage>,
  env: QueueConsumerEnv,
): Promise<{ status: "completed" | "skipped" | "failed"; error?: string }> {
  const { webhookId, topic, shopDomain, rawPayload } = msg.body;
  const prismaClient = initQueueConsumerPrisma(env);

  let event: any;
  try {
    event =
      typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch (parseError) {
    console.error(
      `[Queue Consumer] Malformed JSON payload for webhook ${webhookId}:`,
      parseError,
    );
    msg.ack(); // Drop unparseable payload
    return { status: "skipped", error: "Malformed JSON payload" };
  }

  // 1. D1 Idempotency Guard
  const { isDuplicate } = await checkWebhookIdempotency(
    env,
    prismaClient,
    webhookId,
  );
  if (isDuplicate) {
    msg.ack();
    return { status: "skipped" };
  }

  // 2. Canonical Store Resolution (Invariant 1)
  const store = await resolveShopifyStoreByDomain(shopDomain);
  if (!store) {
    console.warn(`[Queue Consumer] Unresolved store for domain: ${shopDomain}`);
    msg.ack(); // Ack to prevent blocking queue for invalid/deleted stores
    return {
      status: "skipped",
      error: `Unresolved store for domain ${shopDomain}`,
    };
  }

  // 3. Process Event by Topic with Retry / DLQ Protection
  try {
    await dispatchTopic(topic, event, store, prismaClient);

    // 4. Mark completed in D1
    await markWebhookCompleted(env, prismaClient, {
      webhookId,
      storeId: store.storeId || store.shopId,
      topic,
      attempts: msg.attempts || 1,
      payload: event,
    });

    msg.ack();
    return { status: "completed" };
  } catch (err: any) {
    const errorMessage = String(err?.message || err);
    console.error(
      `[Queue Consumer Error] Webhook ${webhookId} failed on attempt ${msg.attempts}:`,
      err,
    );

    await recordWebhookFailure(env, prismaClient, {
      webhookId,
      storeId: store.storeId || store.shopId,
      topic,
      attempts: msg.attempts || 1,
      error: errorMessage,
    });

    if (msg.attempts >= 5) {
      // Exceeded max retries: Route to DLQ
      if (env.ORDER_WEBHOOK_DLQ) {
        await env.ORDER_WEBHOOK_DLQ.send({
          webhookId,
          topic,
          shopDomain,
          rawPayload,
          attempts: msg.attempts,
          error: errorMessage,
          failedAt: Date.now(),
        });
        msg.ack(); // Handled and captured by DLQ
      } else {
        // Fallback to queue retry so Cloudflare native DLQ captures it
        msg.retry({ delaySeconds: 300 });
      }
      return { status: "failed", error: errorMessage };
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, up to 300s
    const backoffSeconds = Math.min(
      2 * Math.pow(2, (msg.attempts || 1) - 1),
      300,
    );
    msg.retry({ delaySeconds: backoffSeconds });
    return { status: "failed", error: errorMessage };
  }
}

export async function handleQueueBatch(
  batch: MessageBatch<WebhookQueueMessage>,
  env: QueueConsumerEnv,
  _ctx?: ExecutionContext,
): Promise<{ processed: number; skipped: number; errors: number }> {
  initQueueConsumerPrisma(env);
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const msg of batch.messages) {
    const res = await processQueueMessage(msg, env);
    if (res.status === "completed") processed++;
    else if (res.status === "skipped") skipped++;
    else errors++;
  }

  return { processed, skipped, errors };
}

const worker = {
  async queue(
    batch: MessageBatch<WebhookQueueMessage>,
    env: QueueConsumerEnv,
    ctx?: ExecutionContext,
  ): Promise<void> {
    initQueueConsumerPrisma(env);
    await handleQueueBatch(batch, env, ctx);
  },
};

export default worker;
