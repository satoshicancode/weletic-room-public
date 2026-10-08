// Disposable SQL crash probe. Shopify and Redis are synthetic; production
// reservation, GraphQL serialization and SQL finalization run in this process.
import type { ShopifyDiscountResult } from "../../../lib/weletic/loyalty/shopify-discounts";

let stage = "target";
async function run(message: unknown) {
  const database = new URL(process.env.DATABASE_URL ?? "invalid:");
  const match = /^\/weletic_loyalty_it_reward_([a-f0-9]{12})$/.exec(
    database.pathname,
  );
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.LOYALTY_REWARD_DATABASE_INTEGRATION !== "1" ||
    !process.send ||
    database.protocol !== "mysql:" ||
    database.hostname !== "127.0.0.1" ||
    database.port !== process.env.LOYALTY_REWARD_DATABASE_PORT ||
    !match ||
    database.username !== `wr_${match[1]}`
  )
    throw new Error("Disposable reward database required");
  const input = message as {
    phase: "before_response" | "after_commit";
    suffix: string;
    rewardDefinitionId: string;
  };
  if (
    !input ||
    !["before_response", "after_commit"].includes(input.phase) ||
    !/^[a-f0-9]{12}$/.test(input.suffix) ||
    input.rewardDefinitionId !== `crash_reward_${input.suffix}_${input.phase}`
  )
    throw new Error("Synthetic crash identity required");

  // Match the parent SQL suite's synthetic coordination boundary. This probe
  // proves SQL process-crash recovery, not Redis lease expiry or supervision.
  process.env.UPSTASH_REDIS_REST_URL = "https://redis-crash.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-redis-token";
  globalThis.fetch = async (url, init) => {
    if (
      String(url) !== "https://redis-crash.invalid/pipeline" ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    )
      throw new Error("External network forbidden in reward crash probe");
    const commands = JSON.parse(init.body) as unknown[][];
    const results = commands.map((command) => {
      const operation = String(command[0]).toLowerCase();
      const key = operation === "set" ? command[1] : command[3];
      if (
        !["set", "eval"].includes(operation) ||
        typeof key !== "string" ||
        !key.startsWith(
          `weletic:shopify:settlement:ws_reward_lifecycle_${input.suffix}:customer:hmac:`,
        )
      )
        throw new Error("Unexpected synthetic Redis command");
      return {
        result: operation === "set" ? Buffer.from("OK").toString("base64") : 1,
      };
    });
    return Response.json(results);
  };
  stage = "sql_identity";
  const { prisma } = await import("../../../lib/prisma");
  const [identity] = await prisma.$queryRaw<
    Array<{ databaseName: string; principal: string }>
  >`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`;
  if (
    identity.databaseName !== database.pathname.slice(1) ||
    identity.principal !== `${database.username}@%`
  )
    throw new Error("Unexpected SQL authority");

  stage = "saga_import";
  const { provisionDiscountSaga } = await import(
    "../../../lib/weletic/loyalty/saga"
  );
  let remote: ShopifyDiscountResult | undefined;
  let creates = 0;
  const holdForCrash = () =>
    new Promise<never>(() => {
      setInterval(() => {}, 1000);
      process.send!({ phase: input.phase, remote, creates });
    });
  const customFetch: typeof fetch = async (url, init) => {
    stage = "provider_request";
    if (
      String(url) !==
        `https://${input.suffix}.myshopify.com/admin/api/2026-10/graphql.json` ||
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      ++creates !== 1
    )
      throw new Error("Unexpected synthetic provider request");
    const request = JSON.parse(init.body);
    const coupon = request.variables?.basicCodeDiscount;
    stage = "provider_contract";
    if (
      !request.query.includes("discountCodeBasicCreate") ||
      coupon?.customerGets?.value?.discountAmount?.amount !== "5.00" ||
      coupon.customerGets.items.all !== true ||
      coupon.usageLimit !== 1 ||
      coupon.appliesOncePerCustomer !== true ||
      coupon.customerSelection.customers.add.length !== 1
    )
      throw new Error("Unexpected five-dollar coupon contract");
    remote = {
      id: `gid://shopify/DiscountCodeNode/crash-${input.suffix}-${input.phase}`,
      code: coupon.code,
      title: coupon.title,
      status: "ACTIVE",
      configuration: {
        kind: "basic",
        startsAt: new Date(
          Math.floor(new Date(coupon.startsAt).getTime() / 1000) * 1000,
        ).toISOString(),
        endsAt: coupon.endsAt,
        usageLimit: coupon.usageLimit,
        appliesOncePerCustomer: coupon.appliesOncePerCustomer,
        appliesOnOneTimePurchase:
          coupon.customerGets.appliesOnOneTimePurchase ?? true,
        appliesOnSubscription:
          coupon.customerGets.appliesOnSubscription ?? false,
        recurringCycleLimit: coupon.recurringCycleLimit ?? 1,
        combinesWith: coupon.combinesWith,
        customerSelection: {
          kind: "customers",
          customerIds: coupon.customerSelection.customers.add,
        },
        minimumRequirement: null,
        basicValue: {
          kind: "amount",
          amount: coupon.customerGets.value.discountAmount.amount,
          currencyCode: "USD",
          appliesOnEachItem: false,
        },
        basicItems: { kind: "all" },
      },
    };
    // The parent retains this synthetic provider record across process death.
    // No response reaches the issuer in the before_response case.
    if (input.phase === "before_response") await holdForCrash();
    return Response.json({
      data: {
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: remote.id,
            codeDiscount: {
              title: remote.title,
              status: remote.status,
              codes: { nodes: [{ code: remote.code }] },
            },
          },
          userErrors: [],
        },
      },
    });
  };
  stage = "issuance";
  const result = await provisionDiscountSaga({
    storeId: `store_reward_lifecycle_${input.suffix}`,
    accountId: `account_reward_lifecycle_${input.suffix}`,
    rewardDefinitionId: input.rewardDefinitionId,
    discountCode: `WL-${input.suffix}-${input.phase}`,
    idempotencyKey: `crash-${input.suffix}-${input.phase}`,
    shopDomain: `${input.suffix}.myshopify.com`,
    accessToken: "synthetic-crash-token",
    customFetch,
  });
  if (!result.success || result.status !== "issued" || creates !== 1)
    throw new Error("Issuance did not commit");
  await holdForCrash();
}

process.once("message", (message) => {
  void run(message).catch((error: unknown) => {
    // SQL/provider errors can contain private material. Never forward them.
    const origin =
      error instanceof Error
        ? error.stack
            ?.match(/\/([a-z0-9-]+\.ts):([0-9]+):[0-9]+/i)
            ?.slice(1)
            .join(":")
        : undefined;
    process.send?.({ failed: true, stage, origin });
    process.exit(1);
  });
});
