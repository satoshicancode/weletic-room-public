import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  requestCreate: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  publishJSON: vi.fn(),
  storeUpdate: vi.fn(),
  storeFindUnique: vi.fn(),
  programUpdateMany: vi.fn(),
  installationFindFirst: vi.fn(),
  appSessionFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  programQueryRaw: vi.fn(),
  transaction: vi.fn(),
  publishPolicyRevision: vi.fn(),
  deriveCustomer: vi.fn(() => ({
    identityKind: "customer_id",
    identityKeyId: "kid_1",
    customerDigest: "SAFE_DIGEST",
  })),
  createBodyDigests: vi.fn(() => [`hmac:v1:kid_1:${"A".repeat(64)}`]),
}));

vi.mock("@/lib/encryption", () => ({ encrypt: mocks.encrypt }));
vi.mock("@/lib/cron", () => ({ qstash: { publishJSON: mocks.publishJSON } }));
vi.mock("@/lib/weletic/ids", () => ({
  createWeleticId: () => "wcomp_1",
}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: mocks.publishPolicyRevision,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyComplianceRequest: {
      create: mocks.requestCreate,
      findUnique: mocks.requestFindUnique,
      updateMany: mocks.requestUpdateMany,
    },
    weleticShopifyStore: {
      findUnique: mocks.storeFindUnique,
      update: mocks.storeUpdate,
    },
    weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
    installedIntegration: { findFirst: mocks.installationFindFirst },
    weleticShopifyAppSession: { findFirst: mocks.appSessionFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  createAllShopifyWebhookBodyDigests: mocks.createBodyDigests,
  deriveShopifyCustomerPrivacyIdentity: mocks.deriveCustomer,
  VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN:
    /^hmac:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-F0-9]{64})$/,
}));
vi.mock("@dub/utils", () => ({
  APP_DOMAIN_WITH_NGROK: "https://weletic.test",
  SHOPIFY_INTEGRATION_ID: "shopify-integration",
  nanoid: () => "test-id",
}));

import {
  dispatchDurableShopifyComplianceRequest,
  SHOPIFY_COMPLIANCE_DISPATCH_TIMEOUT_MS,
  ShopifyComplianceDispatchUnavailableError,
} from "../../lib/weletic/shopify/compliance-dispatch";
import {
  freezeShopifyStoreForShopRedact,
  freezeShopifyStoreForUninstall,
  persistAndQueueInternalShopifyDisconnect,
  persistAndQueueShopifyComplianceRequest,
  persistShopifyComplianceRequest,
} from "../../lib/weletic/shopify/compliance-ingress";

const BODY_DIGESTS = [`hmac:v1:kid_1:${"A".repeat(64)}`] as const;

describe("durable Shopify compliance persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_1",
      status: "pending",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
    });
    mocks.publishJSON.mockResolvedValue({ messageId: "q_1" });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.storeUpdate.mockResolvedValue({ id: "store_1" });
    mocks.storeFindUnique.mockResolvedValue({
      shopDomain: "target.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_one",
    });
    mocks.programUpdateMany.mockResolvedValue({ count: 1 });
    mocks.publishPolicyRevision.mockResolvedValue({ id: "wpolicy_disabled" });
    mocks.installationFindFirst.mockResolvedValue(null);
    mocks.appSessionFindFirst.mockResolvedValue(null);
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "active",
        uninstalledAt: null,
        installationGeneration: "sgen_one",
      },
    ]);
    mocks.programQueryRaw.mockResolvedValue([
      { id: "program_1", disabledAt: null },
    ]);
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: (query: any) => {
          const sql = query?.strings?.join("") ?? "";
          return sql.includes("WeleticLoyaltyProgram")
            ? mocks.programQueryRaw(query)
            : mocks.queryRaw(query);
        },
        weleticShopifyStore: { update: mocks.storeUpdate },
        weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
        installedIntegration: { findFirst: mocks.installationFindFirst },
        weleticShopifyAppSession: { findFirst: mocks.appSessionFindFirst },
        weleticShopifyComplianceRequest: {
          upsert: mocks.requestCreate,
          findUnique: mocks.requestFindUnique,
        },
      }),
    );
  });

  it("never re-persists a raw shop domain or encrypted payload after shop erasure", async () => {
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_1",
      status: "completed",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
    });
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "redacted-kid-safe.invalid",
        complianceState: "redacted",
        uninstalledAt: null,
      },
    ]);
    await persistShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "erased.myshopify.com",
      storageShopDomain: "redacted-kid-safe.invalid",
      alreadyRedacted: true,
      webhookId: "wh_late_redact",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "customers/redact",
      payload: {
        shop_domain: "erased.myshopify.com",
        customer: { id: 42 },
        orders_to_redact: [],
      },
    });

    const data = mocks.requestCreate.mock.calls[0][0].create;
    expect(data).toMatchObject({
      shopDomain: "redacted-kid-safe.invalid",
      status: "completed",
      phase: "already_redacted",
      payloadCiphertext: null,
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
    });
    expect(JSON.stringify(data)).not.toContain("erased.myshopify.com");
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("forces a stale active-domain ingress snapshot privacy-safe when finalization wins before insert", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "redacted-finalized.invalid",
        complianceState: "redacted",
        uninstalledAt: null,
      },
    ]);
    mocks.requestCreate.mockImplementationOnce(async ({ create }) => ({
      ...create,
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
    }));

    await expect(
      persistShopifyComplianceRequest({
        storeId: "store_1",
        canonicalShopDomain: "stale-raw.myshopify.com",
        storageShopDomain: "stale-raw.myshopify.com",
        alreadyRedacted: false,
        webhookId: "wh_finalization_won",
        authenticatedBodyDigests: BODY_DIGESTS,
        topic: "customers/data_request",
        payload: {
          shop_domain: "stale-raw.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    ).resolves.toMatchObject({ status: "completed", created: true });

    const data = mocks.requestCreate.mock.calls[0][0].create;
    expect(data).toMatchObject({
      shopDomain: "redacted-finalized.invalid",
      status: "completed",
      phase: "already_redacted",
      payloadCiphertext: null,
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
    });
    expect(JSON.stringify(data)).not.toContain("stale-raw.myshopify.com");
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("fails a stalled ingress dispatch loudly after making its durable row immediately due", async () => {
    vi.useFakeTimers();
    try {
      const updatedAt = new Date("2026-08-30T00:00:01.000Z");
      mocks.publishJSON.mockReturnValue(new Promise(() => {}));
      mocks.requestFindUnique.mockResolvedValue({
        id: "wcomp_1",
        storeId: "store_1",
        status: "pending",
        phase: "received",
        leaseVersion: 0,
        lockedAt: null,
        lockedBy: null,
        nextRetryAt: null,
        updatedAt,
      });
      const pending = persistAndQueueShopifyComplianceRequest({
        storeId: "store_1",
        canonicalShopDomain: "target.myshopify.com",
        webhookId: "wh_stalled_queue",
        authenticatedBodyDigests: BODY_DIGESTS,
        topic: "shop/redact",
        payload: { shop_domain: "target.myshopify.com" },
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(
        ShopifyComplianceDispatchUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(
        SHOPIFY_COMPLIANCE_DISPATCH_TIMEOUT_MS + 1,
      );
      await rejected;
      expect(mocks.storeUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ complianceState: "frozen" }),
        }),
      );
      expect(mocks.requestUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "wcomp_1",
          storeId: "store_1",
          status: "pending",
          phase: "received",
          leaseVersion: 0,
          lockedAt: null,
          lockedBy: null,
          nextRetryAt: null,
          updatedAt,
        },
        data: {
          status: "retrying",
          nextRetryAt: expect.any(Date),
          lastError:
            "Compliance worker dispatch unavailable; durable retry is immediately due.",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Shopify retry an idempotent signed ingress after the first dispatch fails", async () => {
    const receivedAt = new Date("2026-08-30T00:00:00.000Z");
    const updatedAt = new Date("2026-08-30T00:00:01.000Z");
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_existing",
      storeId: "store_1",
      requestType: "shop_redact",
      authenticatedBodyDigest: BODY_DIGESTS[0],
      shopDomain: "target.myshopify.com",
      status: "pending",
      receivedAt,
      triggeredAt: null,
    });
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_existing",
      storeId: "store_1",
      status: "pending",
      phase: "received",
      leaseVersion: 0,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: null,
      updatedAt,
    });
    mocks.publishJSON
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ messageId: "q_retry" });
    const input = {
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_duplicate_dispatch_retry",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "shop/redact" as const,
      payload: { shop_domain: "target.myshopify.com" },
    };

    await expect(
      persistAndQueueShopifyComplianceRequest(input),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);
    await expect(
      persistAndQueueShopifyComplianceRequest(input),
    ).resolves.toEqual(
      expect.objectContaining({
        requestId: "wcomp_existing",
        created: false,
        status: "pending",
      }),
    );

    expect(mocks.requestCreate).toHaveBeenCalledTimes(2);
    expect(mocks.requestCreate.mock.calls[0][0].where).toEqual({
      webhookId: input.webhookId,
    });
    expect(mocks.requestCreate.mock.calls[1][0].where).toEqual({
      webhookId: input.webhookId,
    });
    expect(mocks.publishJSON).toHaveBeenCalledTimes(2);
  });

  it("preserves a worker retry diagnostic and backoff on duplicate dispatch failure", async () => {
    const retryAt = new Date("2026-08-30T00:05:00.000Z");
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_step_retry",
      storeId: "store_1",
      status: "retrying",
      phase: "voucher_cleanup",
      leaseVersion: 4,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: retryAt,
      updatedAt: new Date("2026-08-30T00:00:01.000Z"),
    });

    await expect(
      dispatchDurableShopifyComplianceRequest({
        requestId: "wcomp_step_retry",
        dispatch: async () => false,
        failurePolicy: "preserve-retry-deadline",
      }),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);

    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves a pending continuation deadline when its queue dispatch fails", async () => {
    const retryAt = new Date("2026-08-30T00:05:00.000Z");
    const updatedAt = new Date("2026-08-30T00:00:01.000Z");
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_pending_continuation",
      storeId: "store_1",
      status: "pending",
      phase: "voucher_cleanup",
      leaseVersion: 4,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: retryAt,
      updatedAt,
    });

    await expect(
      dispatchDurableShopifyComplianceRequest({
        requestId: "wcomp_pending_continuation",
        dispatch: async () => false,
        failurePolicy: "preserve-retry-deadline",
      }),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);

    expect(mocks.requestUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "wcomp_pending_continuation",
        storeId: "store_1",
        status: "pending",
        phase: "voucher_cleanup",
        leaseVersion: 4,
        lockedAt: null,
        lockedBy: null,
        nextRetryAt: retryAt,
        updatedAt,
      },
      data: {
        lastError:
          "Compliance continuation dispatch unavailable; the durable recovery sweep remains authoritative.",
      },
    });
  });

  it("freezes app/uninstalled at the authenticated Shopify event cutoff before queueing", async () => {
    const triggeredAt = new Date("2026-08-29T23:59:00.000Z");
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_1",
      status: "pending",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt,
    });

    await persistAndQueueShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_uninstall",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "app/uninstalled",
      triggeredAt,
      payload: { myshopify_domain: "target.myshopify.com" },
    });

    expect(mocks.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uninstalledAt: triggeredAt }),
      }),
    );
    expect(mocks.publishPolicyRevision).toHaveBeenCalledWith({
      tx: expect.objectContaining({
        weleticShopifyStore: { update: mocks.storeUpdate },
        weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
      }),
      storeId: "store_1",
      programId: "program_1",
      reason: "shopify_uninstall_frozen",
    });
    expect(mocks.publishJSON).toHaveBeenCalledOnce();
  });

  it("does not recreate a policy revision when duplicate shop-redact delivery arrives after loyalty scrub", async () => {
    const frozenAt = new Date("2026-08-30T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "frozen",
        uninstalledAt: null,
        installationGeneration: "sgen_one",
      },
    ]);
    mocks.programQueryRaw.mockResolvedValue([
      { id: "program_1", disabledAt: frozenAt },
    ]);

    await freezeShopifyStoreForShopRedact({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      frozenAt,
    });

    expect(mocks.programUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.publishPolicyRevision).not.toHaveBeenCalled();
  });

  it("does not recreate a policy revision when uninstall recovery revisits an already-frozen store", async () => {
    const cutoff = new Date("2026-08-30T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "frozen",
        uninstalledAt: cutoff,
        installationGeneration: "sgen_one",
      },
    ]);
    mocks.programQueryRaw.mockResolvedValue([
      { id: "program_1", disabledAt: cutoff },
    ]);

    await freezeShopifyStoreForUninstall({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      cutoff,
      expectedInstallationGeneration: "sgen_one",
    });

    expect(mocks.programUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.publishPolicyRevision).not.toHaveBeenCalled();
  });

  it("does not move an uninstall kill-switch later when shop-redact arrives afterward", async () => {
    const uninstallCutoff = new Date("2026-08-29T23:58:00.000Z");
    const shopRedactReceivedAt = new Date("2026-08-30T00:00:00.000Z");
    mocks.requestCreate
      .mockResolvedValueOnce({
        id: "wcomp_1",
        status: "pending",
        receivedAt: uninstallCutoff,
        triggeredAt: uninstallCutoff,
      })
      .mockResolvedValueOnce({
        id: "wcomp_1",
        status: "pending",
        receivedAt: shopRedactReceivedAt,
        triggeredAt: null,
      });
    mocks.programQueryRaw
      .mockResolvedValueOnce([{ id: "program_1", disabledAt: null }])
      .mockResolvedValueOnce([
        { id: "program_1", disabledAt: uninstallCutoff },
      ]);

    await persistAndQueueShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_uninstall_first",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "app/uninstalled",
      triggeredAt: uninstallCutoff,
      payload: { myshopify_domain: "target.myshopify.com" },
    });
    await persistAndQueueShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_shop_later",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "shop/redact",
      payload: { shop_domain: "target.myshopify.com" },
    });

    expect(mocks.programUpdateMany.mock.calls.at(-1)?.[0].data.disabledAt).toBe(
      uninstallCutoff,
    );
    expect(mocks.publishPolicyRevision.mock.calls.at(-1)?.[0]).toEqual({
      tx: expect.objectContaining({
        weleticShopifyStore: { update: mocks.storeUpdate },
        weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
      }),
      storeId: "store_1",
      programId: "program_1",
      reason: "shopify_shop_redact_frozen",
    });
  });

  it("keeps the earliest kill-switch time when distinct shop-redacts are recovered in reverse order", async () => {
    const later = new Date("2026-08-30T00:00:00.000Z");
    const earlier = new Date("2026-08-29T23:59:00.000Z");
    mocks.requestCreate
      .mockResolvedValueOnce({
        id: "wcomp_1",
        status: "pending",
        receivedAt: later,
        triggeredAt: null,
      })
      .mockResolvedValueOnce({
        id: "wcomp_1",
        status: "pending",
        receivedAt: earlier,
        triggeredAt: null,
      });
    mocks.programQueryRaw
      .mockResolvedValueOnce([{ id: "program_1", disabledAt: null }])
      .mockResolvedValueOnce([{ id: "program_1", disabledAt: later }]);

    for (const [webhookId, received] of [
      ["wh_shop_later", later],
      ["wh_shop_earlier", earlier],
    ] as const) {
      await persistAndQueueShopifyComplianceRequest({
        storeId: "store_1",
        canonicalShopDomain: "target.myshopify.com",
        webhookId,
        authenticatedBodyDigests: BODY_DIGESTS,
        topic: "shop/redact",
        payload: { shop_domain: "target.myshopify.com", received },
      });
    }

    expect(mocks.programUpdateMany.mock.calls.at(-1)?.[0].data.disabledAt).toBe(
      earlier,
    );
  });

  it("completes a stale uninstall without freezing a newer immutable generation", async () => {
    const triggeredAt = new Date("2026-08-29T23:59:00.000Z");
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_1",
      status: "pending",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt,
    });
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          id: "store_1",
          projectId: "workspace_1",
          shopDomain: "target.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: "sgen_old",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "store_1",
          projectId: "workspace_1",
          shopDomain: "target.myshopify.com",
          complianceState: "active",
          uninstalledAt: null,
          installationGeneration: "sgen_new",
        },
      ]);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });

    const result = await persistAndQueueShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_stale_uninstall",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "app/uninstalled",
      triggeredAt,
      payload: { myshopify_domain: "target.myshopify.com" },
    });

    expect(result.status).toBe("completed");
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: "stale_after_reinstall" }),
      }),
    );
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.publishJSON).not.toHaveBeenCalled();
  });

  it("freezes the exact immutable generation regardless of verification bookkeeping time", async () => {
    const triggeredAt = new Date("2026-08-29T23:59:00.000Z");
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_1",
      status: "pending",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt,
    });
    const result = await persistAndQueueShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_equal_cutoff_uninstall",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "app/uninstalled",
      triggeredAt,
      payload: { myshopify_domain: "target.myshopify.com" },
    });

    expect(result.status).toBe("pending");
    expect(mocks.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          complianceState: "frozen",
          uninstalledAt: triggeredAt,
        }),
      }),
    );
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.publishJSON).toHaveBeenCalledOnce();
    expect(mocks.installationFindFirst).not.toHaveBeenCalled();
    expect(mocks.appSessionFindFirst).not.toHaveBeenCalled();
  });

  it("stores the subject only as AES-GCM ciphertext for active stores", async () => {
    await persistShopifyComplianceRequest({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      webhookId: "wh_active",
      authenticatedBodyDigests: BODY_DIGESTS,
      topic: "customers/data_request",
      payload: {
        shop_domain: "target.myshopify.com",
        customer: { id: 42 },
        orders_requested: [101],
      },
    });
    const data = mocks.requestCreate.mock.calls[0][0].create;
    expect(data.payloadCiphertext).toContain("encrypted:");
    expect(data.authenticatedBodyDigest).toBe(BODY_DIGESTS[0]);
    expect(data).not.toHaveProperty("payload");
    expect(data).not.toHaveProperty("customerId");
  });

  it("freezes a manual disconnect before returning its durable request", async () => {
    const result = await persistAndQueueInternalShopifyDisconnect({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      idempotencyKey: "installation_1:2026-08-30T00:00:00.000Z",
    });

    expect(result.requestId).toBe("wcomp_1");
    expect(mocks.requestCreate.mock.calls[0][0].create.webhookId).toBe(
      "internal-disconnect:installation_1:2026-08-30T00:00:00.000Z",
    );
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "store_1" },
        data: expect.objectContaining({
          complianceState: "frozen",
          uninstalledAt: new Date("2026-08-30T00:00:00.000Z"),
        }),
      }),
    );
    expect(mocks.publishJSON).toHaveBeenCalled();
  });

  it("retries an idempotent manual disconnect when its first dispatch fails", async () => {
    const receivedAt = new Date("2026-08-30T00:00:00.000Z");
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_existing",
      storeId: "store_1",
      requestType: "app_uninstalled",
      authenticatedBodyDigest: BODY_DIGESTS[0],
      shopDomain: "target.myshopify.com",
      status: "pending",
      receivedAt,
      triggeredAt: null,
    });
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_existing",
      storeId: "store_1",
      status: "pending",
      phase: "received",
      leaseVersion: 0,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: null,
      updatedAt: new Date("2026-08-30T00:00:01.000Z"),
    });
    mocks.publishJSON
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ messageId: "q_retry" });
    const input = {
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      idempotencyKey: "installation_1:2026-08-30T00:00:00.000Z",
    };

    await expect(
      persistAndQueueInternalShopifyDisconnect(input),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);
    await expect(
      persistAndQueueInternalShopifyDisconnect(input),
    ).resolves.toEqual(
      expect.objectContaining({
        requestId: "wcomp_existing",
        created: false,
        status: "pending",
      }),
    );

    expect(mocks.requestCreate).toHaveBeenCalledTimes(2);
    expect(mocks.publishJSON).toHaveBeenCalledTimes(2);
    expect(mocks.storeUpdate).toHaveBeenCalledTimes(2);
  });

  it("preserves the original uninstall cutoff on an idempotent disconnect retry", async () => {
    const cutoff = new Date("2026-08-29T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "frozen",
        uninstalledAt: cutoff,
        installationGeneration: "sgen_one",
      },
    ]);

    await persistAndQueueInternalShopifyDisconnect({
      storeId: "store_1",
      canonicalShopDomain: "target.myshopify.com",
      idempotencyKey: "installation_1:2026-08-30T00:00:00.000Z",
    });

    expect(mocks.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uninstalledAt: cutoff }),
      }),
    );
  });

  it("persists a concurrently finalized manual disconnect as already redacted without raw subject data", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "redacted-safe.invalid",
        complianceState: "redacted",
        uninstalledAt: null,
      },
    ]);
    mocks.requestCreate.mockImplementationOnce(async ({ create }) => ({
      ...create,
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
    }));

    await expect(
      persistAndQueueInternalShopifyDisconnect({
        storeId: "store_1",
        canonicalShopDomain: "target.myshopify.com",
        idempotencyKey: "installation_1:2026-08-30T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.publishJSON).not.toHaveBeenCalled();
    expect(mocks.requestCreate.mock.calls[0][0].create).toMatchObject({
      shopDomain: "redacted-safe.invalid",
      status: "completed",
      phase: "already_redacted",
      payloadCiphertext: null,
    });
  });

  it("accepts an idempotent duplicate signed under a retained previous HMAC key", async () => {
    const previousDigest = `hmac:v1:kid_previous:${"B".repeat(64)}`;
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_existing",
      storeId: "store_1",
      requestType: "customer_data_request",
      authenticatedBodyDigest: previousDigest,
      shopDomain: "target.myshopify.com",
      status: "processing",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
    });

    await expect(
      persistShopifyComplianceRequest({
        storeId: "store_1",
        canonicalShopDomain: "target.myshopify.com",
        webhookId: "wh_duplicate",
        authenticatedBodyDigests: [BODY_DIGESTS[0], previousDigest],
        topic: "customers/data_request",
        payload: {
          shop_domain: "target.myshopify.com",
          customer: { id: 42 },
          orders_requested: [],
        },
      }),
    ).resolves.toMatchObject({ requestId: "wcomp_existing", created: false });
  });

  it.each([
    ["a different authenticated body", `hmac:v1:kid_1:${"C".repeat(64)}`],
    ["a legacy row without a body digest", null],
  ])(
    "rejects a duplicate webhook id bound to %s",
    async (_label, storedDigest) => {
      mocks.requestCreate.mockResolvedValue({
        id: "wcomp_existing",
        storeId: "store_1",
        requestType: "customer_data_request",
        authenticatedBodyDigest: storedDigest,
        shopDomain: "target.myshopify.com",
        status: "processing",
        receivedAt: new Date("2026-08-30T00:00:00.000Z"),
        triggeredAt: null,
      });

      await expect(
        persistShopifyComplianceRequest({
          storeId: "store_1",
          canonicalShopDomain: "target.myshopify.com",
          webhookId: "wh_collision",
          authenticatedBodyDigests: BODY_DIGESTS,
          topic: "customers/data_request",
          payload: {
            shop_domain: "target.myshopify.com",
            customer: { id: 42 },
            orders_requested: [],
          },
        }),
      ).rejects.toThrow("belongs to another tenant, topic, or shop domain");
    },
  );

  it("rejects an uninstall duplicate that omits its persisted authenticated cutoff", async () => {
    mocks.requestCreate.mockResolvedValue({
      id: "wcomp_existing_uninstall",
      storeId: "store_1",
      requestType: "app_uninstalled",
      authenticatedBodyDigest: BODY_DIGESTS[0],
      shopDomain: "target.myshopify.com",
      status: "processing",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: new Date("2026-08-29T23:59:00.000Z"),
    });

    await expect(
      persistShopifyComplianceRequest({
        storeId: "store_1",
        canonicalShopDomain: "target.myshopify.com",
        webhookId: "wh_uninstall_cutoff_collision",
        authenticatedBodyDigests: BODY_DIGESTS,
        topic: "app/uninstalled",
        payload: { myshopify_domain: "target.myshopify.com" },
      }),
    ).rejects.toThrow("belongs to another tenant, topic, or shop domain");
  });
});
