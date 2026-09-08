import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import "dotenv-flow/config";
import crypto from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type SupportedTopic =
  | "orders/paid"
  | "refunds/create"
  | "discounts/delete"
  | "discounts/update"
  | "products/create"
  | "products/update"
  | "products/delete"
  | "markets/create"
  | "markets/update"
  | "markets/delete"
  | "app/uninstalled"
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export interface SimulatorOptions {
  topic: SupportedTopic | string;
  code?: string;
  orderId?: number | string;
  refundId?: number | string;
  productId?: number | string;
  amount?: string;
  currency?: string;
  shop?: string;
  target?: string;
  secret?: string;
  webhookId?: string;
  duplicate?: boolean;
  tamper?: boolean;
  verifyDb?: boolean;
  json?: boolean;
  help?: boolean;
  interactive?: boolean;
}

export interface DispatchResult {
  status: number;
  ok: boolean;
  response: string;
  headers: Record<string, string>;
  durationMs: number;
  webhookId: string;
  signature: string;
}

// ============================================================================
// HMAC Signature Generation
// ============================================================================

/** Computes a Shopify-compatible body HMAC-SHA256 Base64 signature. */
export function computeShopifyHmac(body: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
}

function requireShopifyWebhookSecret(explicitSecret?: string): string {
  const secret =
    explicitSecret?.trim() || process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "SHOPIFY_WEBHOOK_SECRET is required. Set it in the environment or pass --secret.",
    );
  }
  return secret;
}

// ============================================================================
// Synthetic Shopify-shaped Payload Builders
// ============================================================================

export function buildMockPayload(
  topic: string,
  options: {
    code?: string;
    orderId?: number | string;
    refundId?: number | string;
    productId?: number | string;
    amount?: string;
    currency?: string;
    shop?: string;
  } = {},
): Record<string, any> {
  const code = options.code || "HIRO";
  const currency = options.currency || "USD";
  const rawAmount = options.amount || (currency === "JPY" ? "12000" : "120.00");
  const shopDomain = options.shop || "yamaxdev.myshopify.com";
  const orderId = Number(options.orderId) || 589283748234;
  const refundId = Number(options.refundId) || 883746282;
  const productId = Number(options.productId) || 87654321;
  const now = new Date().toISOString();

  // Price formatting helper based on currency
  const isZeroDecimal = currency === "JPY" || currency === "VND";
  const numericAmount = parseFloat(rawAmount) || 120;
  const formattedAmount = isZeroDecimal
    ? Math.round(numericAmount).toString()
    : numericAmount.toFixed(2);

  const discountAmountNum = numericAmount * 0.1;
  const totalAmountNum = numericAmount * 0.9;
  const discountAmount = isZeroDecimal
    ? Math.round(discountAmountNum).toString()
    : discountAmountNum.toFixed(2);
  const totalAmount = isZeroDecimal
    ? Math.round(totalAmountNum).toString()
    : totalAmountNum.toFixed(2);

  const line1Amount = isZeroDecimal
    ? Math.round(numericAmount * 0.6667).toString()
    : (numericAmount * 0.6667).toFixed(2);
  const line2Amount = isZeroDecimal
    ? Math.round(numericAmount * 0.3333).toString()
    : (numericAmount * 0.3333).toFixed(2);

  const line1Discount = isZeroDecimal
    ? Math.round(discountAmountNum * 0.6667).toString()
    : (discountAmountNum * 0.6667).toFixed(2);
  const line2Discount = isZeroDecimal
    ? Math.round(discountAmountNum * 0.3333).toString()
    : (discountAmountNum * 0.3333).toFixed(2);

  switch (topic) {
    case "orders/paid":
      return {
        id: orderId,
        name: `#${orderId % 10000 || 1042}`,
        confirmation_number: `WDQ${Math.floor(100000 + Math.random() * 900000)}`,
        checkout_token: `tok_yamax_checkout_${Date.now()}`,
        created_at: now,
        processed_at: now,
        financial_status: "paid",
        currency,
        customer: {
          id: 97773681707702,
          first_name: "Hiro",
          last_name: "Nguyen",
          email: "hiro@weletic.com",
        },
        current_subtotal_price_set: {
          shop_money: { amount: formattedAmount, currency_code: currency },
          presentment_money: {
            amount: formattedAmount,
            currency_code: currency,
          },
        },
        current_total_discounts_set: {
          shop_money: { amount: discountAmount, currency_code: currency },
          presentment_money: {
            amount: discountAmount,
            currency_code: currency,
          },
        },
        current_total_price_set: {
          shop_money: { amount: totalAmount, currency_code: currency },
          presentment_money: { amount: totalAmount, currency_code: currency },
        },
        discount_codes: [
          {
            code,
          },
        ],
        line_items: [
          {
            id: 987654321,
            product_id: 87654321,
            variant_id: 76543210,
            sku: "YMX-FLOW-BLK-M",
            title: "Yamax Flow™ High-Rise Leggings - Black / M",
            quantity: 1,
            price_set: {
              shop_money: { amount: line1Amount, currency_code: currency },
              presentment_money: {
                amount: line1Amount,
                currency_code: currency,
              },
            },
            total_discount_set: {
              shop_money: { amount: line1Discount, currency_code: currency },
              presentment_money: {
                amount: line1Discount,
                currency_code: currency,
              },
            },
          },
          {
            id: 987654322,
            product_id: 87654322,
            variant_id: 76543211,
            sku: "YMX-AGILE-BLK-S",
            title: "Yamax Agile™ Sports Bra - Black / S",
            quantity: 1,
            price_set: {
              shop_money: { amount: line2Amount, currency_code: currency },
              presentment_money: {
                amount: line2Amount,
                currency_code: currency,
              },
            },
            total_discount_set: {
              shop_money: { amount: line2Discount, currency_code: currency },
              presentment_money: {
                amount: line2Discount,
                currency_code: currency,
              },
            },
          },
        ],
        billing_address: {
          province: "Tokyo",
          country_code: "JP",
        },
      };

    case "refunds/create":
      return {
        id: refundId,
        order_id: orderId,
        created_at: now,
        note: "Customer sizing return for Yamax Leggings (ADR 0004 proportional refund test)",
        refund_line_items: [
          {
            id: 77263541,
            line_item_id: 987654321,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: formattedAmount, currency_code: currency },
              presentment_money: {
                amount: formattedAmount,
                currency_code: currency,
              },
            },
          },
        ],
      };

    case "discounts/delete":
      return {
        id: 1234567890123,
        admin_graphql_api_id: "gid://shopify/DiscountCodeNode/1234567890123",
        code,
        title: `Yamax 10% Partner Discount - ${code}`,
      };

    case "discounts/update":
      return {
        id: 1234567890123,
        admin_graphql_api_id: "gid://shopify/DiscountCodeNode/1234567890123",
        title: `Yamax 10% Partner Discount - ${code}`,
        status: "EXPIRED",
        codes: [
          {
            id: 1122334455,
            code,
          },
        ],
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: now,
      };

    case "products/create":
    case "products/update":
      return {
        id: productId,
        title: "Yamax Flow™ High-Rise Leggings",
        handle: "yamax-flow-high-rise-leggings",
        product_type: "Activewear",
        vendor: "Yamax Activewear",
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: now,
        variants: [
          {
            id: 76543210,
            product_id: productId,
            title: "Black / M",
            price: formattedAmount,
            sku: "YMX-FLOW-BLK-M",
            inventory_quantity: 150,
          },
          {
            id: 76543211,
            product_id: productId,
            title: "Sage Green / S",
            price: formattedAmount,
            sku: "YMX-FLOW-GRN-S",
            inventory_quantity: 85,
          },
        ],
      };

    case "products/delete":
      return {
        id: productId,
      };

    case "markets/create":
    case "markets/update":
    case "markets/delete":
      return {
        id: 10293847,
        name: "Japan Market",
        currency_code: "JPY",
        enabled: true,
      };

    case "app/uninstalled":
      return {
        id: 123456789,
        name: "Yamax Activewear",
        myshopify_domain: shopDomain,
      };

    case "customers/data_request":
      return {
        shop_id: 98765432,
        shop_domain: shopDomain,
        customer: {
          id: 97773681707702,
          email: "hiro@weletic.com",
          phone: "+15555550123",
        },
        orders_requested: [orderId],
      };

    case "customers/redact":
      return {
        shop_id: 98765432,
        shop_domain: shopDomain,
        customer: {
          id: 97773681707702,
          email: "hiro@weletic.com",
          phone: "+15555550123",
        },
        orders_to_redact: [orderId],
      };

    case "shop/redact":
      return {
        shop_id: 98765432,
        shop_domain: shopDomain,
      };

    default:
      return {
        id: orderId,
        topic,
        timestamp: now,
        shop_domain: shopDomain,
      };
  }
}

// ============================================================================
// Webhook HTTP Dispatcher
// ============================================================================

export interface DispatchShopifyWebhookOptions {
  topic: string;
  payload: any;
  shopDomain?: string;
  secret?: string;
  /** Private A1 maintenance owner credential. Never returned or logged. */
  maintenanceOwnerToken?: string;
  webhookId?: string;
  triggeredAt?: string;
  url?: string;
  tamper?: boolean;
}

export async function dispatchShopifyWebhook({
  topic,
  payload,
  shopDomain = "yamaxdev.myshopify.com",
  secret,
  maintenanceOwnerToken,
  webhookId = `wh_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  triggeredAt = new Date().toISOString(),
  url = `${APP_DOMAIN_WITH_NGROK || "http://app.localhost:8888"}/api/shopify/integration/webhook`,
  tamper = false,
}: DispatchShopifyWebhookOptions): Promise<DispatchResult> {
  const rawBody = JSON.stringify(payload);
  const signature = computeShopifyHmac(
    rawBody,
    requireShopifyWebhookSecret(secret),
  );

  // If tamper mode is requested, modify the dispatched body after HMAC computation
  const bodyToSend = tamper ? `${rawBody} ` : rawBody;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": shopDomain,
    "x-shopify-hmac-sha256": signature,
    "x-shopify-webhook-id": webhookId,
    "x-shopify-api-version": "2026-07",
    // Shopify supplies this delivery timestamp as a separate header. The
    // body HMAC does not cryptographically bind the header value; compliance
    // ingress validates its timestamp policy independently.
    "x-shopify-triggered-at": triggeredAt,
    "user-agent": "Shopify-Webhook-Simulator/1.0 (Weletic)",
  };
  const requestHeaders = maintenanceOwnerToken
    ? {
        ...headers,
        "x-weletic-loyalty-maintenance-token": maintenanceOwnerToken,
      }
    : headers;

  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: bodyToSend,
    });
    const durationMs = Date.now() - startTime;
    const responseText = await res.text();

    return {
      status: res.status,
      ok: res.ok,
      response: responseText,
      headers,
      durationMs,
      webhookId,
      signature,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 0,
      ok: false,
      response: `Network error connecting to ${url}: ${errorMessage}`,
      headers,
      durationMs,
      webhookId,
      signature,
    };
  }
}

export async function dispatchShopifyWebhookDeliveries({
  duplicate = false,
  webhookId = `wh_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  triggeredAt = new Date().toISOString(),
  ...options
}: DispatchShopifyWebhookOptions & {
  duplicate?: boolean;
}): Promise<DispatchResult[]> {
  const dispatch = () =>
    dispatchShopifyWebhook({
      ...options,
      webhookId,
      triggeredAt,
    });

  return duplicate ? Promise.all([dispatch(), dispatch()]) : [await dispatch()];
}

// ============================================================================
// Database Verification Helper
// ============================================================================

async function verifyDatabaseState(options: {
  topic: string;
  orderId?: number | string;
  refundId?: number | string;
  code?: string;
  webhookId?: string;
}) {
  try {
    const { prisma } = await import("@/lib/prisma");

    const summary: Record<string, any> = {};

    if (options.webhookId) {
      const eventRecord = await prisma.weleticShopifyWebhookEvent.findUnique({
        where: { webhookId: options.webhookId },
      });
      if (eventRecord) {
        summary.webhookEvent = {
          id: eventRecord.id,
          status: eventRecord.status,
          attempts: eventRecord.attempts,
          topic: eventRecord.topic,
          error: eventRecord.error,
        };
      }
    }

    if (options.topic === "orders/paid" && options.orderId) {
      const order = await prisma.weleticCommerceOrder.findFirst({
        where: { externalId: String(options.orderId) },
        include: {
          lines: true,
          refunds: true,
        },
      });
      if (order) {
        summary.commerceOrder = {
          id: order.id,
          orderName: order.orderName,
          shopCurrency: order.shopCurrency,
          shopSubtotal: order.shopSubtotal.toString(),
          lineCount: order.lines.length,
          refundCount: order.refunds.length,
        };
      }
    }

    if (options.topic === "refunds/create" && options.refundId) {
      const refund = await prisma.weleticCommerceRefund.findFirst({
        where: { externalId: String(options.refundId) },
        include: {
          lines: true,
        },
      });
      if (refund) {
        summary.commerceRefund = {
          id: refund.id,
          orderId: refund.orderId,
          shopAmount: refund.shopAmount.toString(),
          lineCount: refund.lines.length,
        };
      }
    }

    if (
      (options.topic === "discounts/delete" ||
        options.topic === "discounts/update") &&
      options.code
    ) {
      const discountCode = await prisma.discountCode.findFirst({
        where: { code: options.code },
        select: {
          id: true,
          code: true,
          disabledAt: true,
          updatedAt: true,
        },
      });
      summary.discountCode = discountCode || { status: "not_found_or_deleted" };
    }

    return summary;
  } catch (error) {
    return {
      dbError: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// CLI Flags Parser
// ============================================================================

export function parseCliArgs(args: string[]): SimulatorOptions {
  const options: SimulatorOptions = {
    topic: "orders/paid",
    code: "HIRO",
    amount: "120.00",
    currency: "USD",
    shop: "yamaxdev.myshopify.com",
    target: `${APP_DOMAIN_WITH_NGROK || "http://app.localhost:8888"}/api/shopify/integration/webhook`,
    secret: process.env.SHOPIFY_WEBHOOK_SECRET,
    duplicate: false,
    tamper: false,
    verifyDb: true,
    json: false,
    help: false,
    interactive: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--interactive" || arg === "-i") {
      options.interactive = true;
    } else if (arg === "--duplicate") {
      options.duplicate = true;
    } else if (arg === "--tamper") {
      options.tamper = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verify-db") {
      options.verifyDb = true;
    } else if (arg === "--no-verify-db") {
      options.verifyDb = false;
    } else if (arg === "--topic" || arg === "-t") {
      options.topic = args[++i] || options.topic;
    } else if (arg.startsWith("--topic=")) {
      options.topic = arg.split("=")[1];
    } else if (arg === "--code" || arg === "-c") {
      options.code = args[++i] || options.code;
    } else if (arg.startsWith("--code=")) {
      options.code = arg.split("=")[1];
    } else if (arg === "--order-id") {
      options.orderId = args[++i];
    } else if (arg.startsWith("--order-id=")) {
      options.orderId = arg.split("=")[1];
    } else if (arg === "--refund-id") {
      options.refundId = args[++i];
    } else if (arg.startsWith("--refund-id=")) {
      options.refundId = arg.split("=")[1];
    } else if (arg === "--product-id") {
      options.productId = args[++i];
    } else if (arg.startsWith("--product-id=")) {
      options.productId = arg.split("=")[1];
    } else if (arg === "--amount" || arg === "-a") {
      options.amount = args[++i] || options.amount;
    } else if (arg.startsWith("--amount=")) {
      options.amount = arg.split("=")[1];
    } else if (arg === "--currency") {
      options.currency = args[++i]?.toUpperCase() || options.currency;
    } else if (arg.startsWith("--currency=")) {
      options.currency = arg.split("=")[1]?.toUpperCase();
    } else if (arg === "--shop" || arg === "-s") {
      options.shop = args[++i] || options.shop;
    } else if (arg.startsWith("--shop=")) {
      options.shop = arg.split("=")[1];
    } else if (arg === "--target" || arg === "-u" || arg === "--url") {
      options.target = args[++i] || options.target;
    } else if (arg.startsWith("--target=") || arg.startsWith("--url=")) {
      options.target = arg.split("=")[1];
    } else if (arg === "--secret") {
      options.secret = args[++i] || options.secret;
    } else if (arg.startsWith("--secret=")) {
      options.secret = arg.split("=")[1];
    } else if (arg === "--webhook-id") {
      options.webhookId = args[++i];
    } else if (arg.startsWith("--webhook-id=")) {
      options.webhookId = arg.split("=")[1];
    }
  }

  // If no arguments were given and we're in an interactive TTY, trigger interactive mode
  if (args.length === 0 && process.stdout.isTTY && !options.json) {
    options.interactive = true;
  }

  return options;
}

// ============================================================================
// Interactive TTY Prompts
// ============================================================================

async function runInteractivePrompt(
  initialOptions: SimulatorOptions,
): Promise<SimulatorOptions> {
  const rl = readline.createInterface({ input, output });

  console.log(
    "\n╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║            ⚡ WELETIC SHOPIFY WEBHOOK SIMULATOR ⚡            ║",
  );
  console.log(
    "║      2-Way Synchronization & Local-to-Production Parity       ║",
  );
  console.log(
    "╚═══════════════════════════════════════════════════════════════╝\n",
  );

  const topics: SupportedTopic[] = [
    "orders/paid",
    "refunds/create",
    "discounts/delete",
    "discounts/update",
    "products/update",
    "products/delete",
    "products/create",
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ];

  console.log("Select Webhook Topic:");
  topics.forEach((t, i) => console.log(`  [${i + 1}] ${t}`));

  const topicChoice = await rl.question(
    `\nSelect topic (1-${topics.length}) [default: 1 (orders/paid)]: `,
  );
  const topicIndex = parseInt(topicChoice.trim(), 10) - 1;
  const selectedTopic = topics[topicIndex] || "orders/paid";

  const code =
    selectedTopic === "orders/paid" || selectedTopic.startsWith("discounts/")
      ? (await rl.question(`Partner Discount Code [default: HIRO]: `)).trim() ||
        "HIRO"
      : undefined;

  const amount =
    selectedTopic === "orders/paid" || selectedTopic === "refunds/create"
      ? (await rl.question(`Amount [default: 120.00]: `)).trim() || "120.00"
      : undefined;

  const currency =
    selectedTopic === "orders/paid" || selectedTopic === "refunds/create"
      ? (await rl.question(`Currency (USD, JPY, EUR, VND) [default: USD]: `))
          .trim()
          .toUpperCase() || "USD"
      : "USD";

  const shop =
    (
      await rl.question(
        `Shopify Store Domain [default: yamaxdev.myshopify.com]: `,
      )
    ).trim() || "yamaxdev.myshopify.com";

  const target =
    (
      await rl.question(
        `Target Endpoint [default: ${APP_DOMAIN_WITH_NGROK || "http://app.localhost:8888"}/api/shopify/integration/webhook]: `,
      )
    ).trim() ||
    `${APP_DOMAIN_WITH_NGROK || "http://app.localhost:8888"}/api/shopify/integration/webhook`;

  const duplicateAns = (
    await rl.question(
      `Test Concurrent Duplicate Delivery (Idempotency)? (y/N): `,
    )
  )
    .trim()
    .toLowerCase();
  const duplicate = duplicateAns === "y" || duplicateAns === "yes";

  const tamperAns = (
    await rl.question(`Test Tampered Signature Rejection (401)? (y/N): `)
  )
    .trim()
    .toLowerCase();
  const tamper = tamperAns === "y" || tamperAns === "yes";

  const verifyDbAns = (
    await rl.question(`Verify Database State After Dispatch? (Y/n): `)
  )
    .trim()
    .toLowerCase();
  const verifyDb = verifyDbAns !== "n" && verifyDbAns !== "no";

  rl.close();

  return {
    ...initialOptions,
    topic: selectedTopic,
    code,
    amount,
    currency,
    shop,
    target,
    duplicate,
    tamper,
    verifyDb,
  };
}

// ============================================================================
// Help Formatter
// ============================================================================

function printHelp() {
  console.log(`
Weletic Shopify Webhook Simulator (pnpm test:webhook)
Usage:
  pnpm test:webhook [options]
  dotenv-flow -e .env -- tsx ./scripts/dev/simulate-shopify-webhook.ts [options]

Options:
  -t, --topic <name>       Shopify webhook topic (default: "orders/paid")
                           Supported: orders/paid, refunds/create, discounts/delete,
                           discounts/update, products/update, products/delete,
                           products/create, app/uninstalled, customers/data_request,
                           customers/redact, shop/redact
  -c, --code <code>        Partner discount attribution code (default: "HIRO")
  -a, --amount <amount>    Order subtotal or refund amount (default: "120.00")
      --currency <code>    Currency code: USD, JPY, EUR, VND (default: "USD")
      --order-id <id>      Shopify Order ID for correlation
      --refund-id <id>     Shopify Refund ID for correlation
      --product-id <id>    Shopify Product ID for product sync
  -s, --shop <domain>      Shopify store myshopify domain (default: "yamaxdev.myshopify.com")
  -u, --target <url>       Target webhook URL (default: \${APP_DOMAIN_WITH_NGROK}/api/shopify/integration/webhook)
      --secret <secret>    Webhook HMAC secret (default: process.env.SHOPIFY_WEBHOOK_SECRET)
      --webhook-id <id>    Custom x-shopify-webhook-id header
      --duplicate          Dispatch 2 concurrent requests to test idempotency deduplication
      --tamper             Alter body after HMAC generation to test 401 signature rejection
      --verify-db          Query database after dispatch to verify created records (default: true)
      --no-verify-db       Skip database state check
      --json               Output raw JSON response only (for CI/CD pipelines)
  -i, --interactive        Run in interactive prompt mode
  -h, --help               Display this help message

Examples:
  pnpm test:webhook --topic orders/paid --code HIRO --amount 120.00
  pnpm test:webhook --topic refunds/create --order-id 589283748234 --amount 72.00
  pnpm test:webhook --topic discounts/delete --code HIRO
  pnpm test:webhook --topic orders/paid --duplicate
  pnpm test:webhook --topic orders/paid --tamper
`);
}

// ============================================================================
// Main Execution Runner
// ============================================================================

export async function main() {
  const args = process.argv.slice(2);
  let options = parseCliArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.interactive) {
    options = await runInteractivePrompt(options);
  }

  const topic = options.topic || "orders/paid";
  const shopDomain = options.shop || "yamaxdev.myshopify.com";
  const secret = requireShopifyWebhookSecret(options.secret);
  const targetUrl =
    options.target ||
    `${APP_DOMAIN_WITH_NGROK || "http://app.localhost:8888"}/api/shopify/integration/webhook`;
  const webhookId =
    options.webhookId ||
    `wh_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = buildMockPayload(topic, options);

  if (!options.json) {
    console.log("\n🚀 Dispatching Simulated Shopify Webhook:");
    console.log(`   Topic:      ${topic}`);
    console.log(`   Shop:       ${shopDomain}`);
    console.log(`   Target:     ${targetUrl}`);
    console.log(`   Webhook ID: ${webhookId}`);
    if (options.duplicate) {
      console.log(
        `   Mode:       ⚡ Concurrent Duplicate Test (2 simultaneous requests)`,
      );
    }
    if (options.tamper) {
      console.log(
        `   Mode:       ⚠️ Tampered Body (Testing 401 Signature Rejection)`,
      );
    }
    console.log("");
  }

  const results = await dispatchShopifyWebhookDeliveries({
    topic,
    payload,
    shopDomain,
    secret,
    webhookId,
    url: targetUrl,
    tamper: options.tamper,
    duplicate: options.duplicate,
  });

  let dbVerification: any = null;
  if (options.verifyDb && !options.tamper) {
    dbVerification = await verifyDatabaseState({
      topic,
      orderId: payload.id || options.orderId,
      refundId: payload.id || options.refundId,
      code: options.code || payload.code,
      webhookId,
    });
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: results.every((r) => r.ok),
          results: results.map((r) => ({
            status: r.status,
            ok: r.ok,
            durationMs: r.durationMs,
            response: r.response,
            webhookId: r.webhookId,
            signature: r.signature,
          })),
          payload,
          dbVerification,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Pretty Console Output
  results.forEach((res, index) => {
    const label = results.length > 1 ? `Request #${index + 1}` : "Response";
    const statusIcon = res.ok ? "✅" : res.status === 409 ? "🔁" : "❌";
    console.log(
      `${statusIcon} ${label}: HTTP ${res.status} (${res.durationMs}ms)`,
    );
    console.log(`   HMAC-SHA256: ${res.signature}`);
    console.log(`   Body:        ${res.response}`);
    console.log("");
  });

  if (dbVerification && Object.keys(dbVerification).length > 0) {
    console.log("🔍 Database Verification State:");
    console.log(JSON.stringify(dbVerification, null, 2));
    console.log("");
  }
}

// Auto-run when executed directly via CLI
if (typeof require !== "undefined" && require.main === module) {
  main().catch((err) => {
    console.error("Simulation error:", err);
    process.exit(1);
  });
} else if (
  process.argv[1] &&
  process.argv[1].endsWith("simulate-shopify-webhook.ts")
) {
  main().catch((err) => {
    console.error("Simulation error:", err);
    process.exit(1);
  });
}
