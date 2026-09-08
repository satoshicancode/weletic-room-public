import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindMany: vi.fn(),
  artifactFindFirst: vi.fn(),
  artifactFindUnique: vi.fn(),
  artifactCreate: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactUpdateMany: vi.fn(),
  artifactFindUniqueOrThrow: vi.fn(),
  requestFindFirst: vi.fn(),
  requestFindMany: vi.fn(),
  requestFindUnique: vi.fn(),
  deriveIdentities: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  storageDelete: vi.fn(),
  storageUpload: vi.fn(),
  signedDownload: vi.fn(),
  plainCreateThread: vi.fn(),
  projectUserFindFirstOrThrow: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));
vi.mock("@/lib/plain/create-plain-thread", () => ({
  createPlainThread: mocks.plainCreateThread,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: (() => {
    const client = {
      weleticShopifyComplianceArtifact: {
        findMany: mocks.artifactFindMany,
        findFirst: mocks.artifactFindFirst,
        findUnique: mocks.artifactFindUnique,
        findUniqueOrThrow: mocks.artifactFindUniqueOrThrow,
        create: mocks.artifactCreate,
        update: mocks.artifactUpdate,
        updateMany: mocks.artifactUpdateMany,
      },
      weleticShopifyComplianceRequest: {
        findFirst: mocks.requestFindFirst,
        findMany: mocks.requestFindMany,
        findUnique: mocks.requestFindUnique,
      },
      projectUsers: {
        findFirstOrThrow: mocks.projectUserFindFirstOrThrow,
      },
      $queryRaw: mocks.queryRaw,
      $transaction: (input: unknown) => mocks.transaction(input, client),
    };
    return client;
  })(),
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    delete: mocks.storageDelete,
    upload: mocks.storageUpload,
    getSignedDownloadUrl: mocks.signedDownload,
  },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyCustomerPrivacyIdentities: mocks.deriveIdentities,
}));
vi.mock("@dub/utils", () => ({
  APP_DOMAIN_WITH_NGROK: "https://weletic.test",
  nanoid: () => "test-id",
}));

import { createHash } from "node:crypto";
import {
  createComplianceExportDownload,
  deleteComplianceArtifactsForCustomerRedactionBatch,
  deleteComplianceArtifactsForStoreBatch,
  deleteExpiredComplianceArtifactsBatch,
  deliverComplianceExportReference,
  ensureComplianceExportManifest,
  storeEncryptedComplianceArtifact,
} from "../../lib/weletic/shopify/compliance-artifacts";

describe("encrypted compliance artifact lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STORAGE_ENDPOINT = "https://storage.test";
    process.env.STORAGE_PRIVATE_BUCKET = "private";
    process.env.STORAGE_ACCESS_KEY_ID = "access";
    process.env.STORAGE_SECRET_ACCESS_KEY = "secret";
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.storageDelete.mockResolvedValue(undefined);
    mocks.artifactUpdateMany.mockResolvedValue({ count: 1 });
    mocks.artifactUpdate.mockResolvedValue({});
    mocks.artifactFindFirst.mockResolvedValue(null);
    mocks.artifactFindUnique.mockResolvedValue(null);
    mocks.artifactCreate.mockImplementation(async ({ data }) => data);
    mocks.artifactFindUniqueOrThrow.mockImplementation(async ({ where }) => ({
      id: where.id,
    }));
    mocks.projectUserFindFirstOrThrow.mockResolvedValue({
      user: {
        id: "user_1",
        name: "Owner",
        email: "owner@example.com",
      },
    });
    mocks.plainCreateThread.mockResolvedValue({ id: "plain_thread_1" });
    mocks.requestFindFirst.mockImplementation(({ where }) =>
      where.id === "wcomp_1"
        ? {
            id: "wcomp_1",
            storeId: "store_1",
            subjectKind: "customer_id",
            subjectKeyId: "current-kid",
            subjectDigest: "SAFE_DIGEST",
            progress: { ownerShopperId: "shopper_1" },
            store: { complianceState: "active" },
          }
        : null,
    );
    mocks.queryRaw.mockResolvedValue([{ id: "wcomp_1", status: "completed" }]);
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_1",
      storeId: "store_1",
      subjectKind: "customer_id",
      subjectKeyId: "current-kid",
      subjectDigest: "SAFE_DIGEST",
      progress: { ownerShopperId: "shopper_1" },
      phase: "completed",
      store: { complianceState: "active" },
    });
    mocks.requestFindMany.mockResolvedValue([]);
    mocks.deriveIdentities.mockReturnValue([]);
    mocks.transaction.mockImplementation(async (input, client) =>
      typeof input === "function" ? input(client) : input,
    );
  });

  it("deletes expired private objects and irreversibly scrubs bearer material", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_1",
        requestId: "wcomp_1",
        kind: "identity",
        storageKey: "compliance/expired.enc",
        expiresAt,
        updatedAt,
      },
    ]);
    const result = await deleteExpiredComplianceArtifactsBatch({
      now: new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(result).toEqual({ selected: 1, deleted: 1, failed: 0 });
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: "compliance/expired.enc",
      bucket: "private",
    });
    expect(mocks.artifactUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "artifact_1",
          deletedAt: null,
          updatedAt,
        }),
        data: expect.objectContaining({
          lastError: expect.stringMatching(/^expiry-delete:/),
        }),
      }),
    );
    expect(mocks.artifactUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          downloadTokenHash: null,
          downloadTokenCiphertext: null,
          downloadTokenKeyId: null,
          downloadTokenExpiresAt: null,
        }),
      }),
    );
  });

  it("supports bounded immediate artifact erasure during shop redaction", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: "artifact_1", storageKey: "compliance/private.enc" },
    ]);
    const result = await deleteComplianceArtifactsForStoreBatch({
      storeId: "store_1",
      batchSize: 20,
    });

    expect(result).toEqual({ selected: 1, deleted: 1, failed: 0 });
    expect(mocks.artifactFindMany).toHaveBeenCalledWith({
      where: { storeId: "store_1", deletedAt: null },
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true, storageKey: true },
    });
  });

  it("does not delete an artifact whose expiry generation was concurrently extended", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_extended",
        requestId: "wcomp_1",
        kind: "orders",
        storageKey: "compliance/extended.enc",
        expiresAt,
        updatedAt,
      },
    ]);
    // The manifest reconciler moved expiresAt/updatedAt after selection, so
    // the claim CAS loses before any external delete is attempted.
    mocks.artifactUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 0, failed: 0 });

    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });

  it("does not require private storage when an expiry sweep selects no objects", async () => {
    vi.stubEnv("STORAGE_ENDPOINT", "");
    vi.stubEnv("STORAGE_PRIVATE_BUCKET", "");
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", "");
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "");
    mocks.artifactFindMany.mockResolvedValue([]);

    await expect(deleteExpiredComplianceArtifactsBatch()).resolves.toEqual({
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });

  it("keeps expired normal chunks while their data request is still processing", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_slow_export",
        requestId: "wcomp_1",
        kind: "ledger",
        storageKey: "compliance/slow-export.enc",
        expiresAt,
        updatedAt,
      },
    ]);
    mocks.queryRaw.mockResolvedValueOnce([
      { id: "wcomp_1", status: "processing" },
    ]);

    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 0, failed: 0 });

    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });

  it("cancels an expired cleanup intent without deleting its live authoritative object", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "cleanup_intent_1",
        requestId: "wcomp_1",
        kind: "upload_cleanup:SAFE_HASH",
        storageKey: "compliance/live-winner.enc",
        expiresAt,
        updatedAt,
      },
    ]);
    mocks.artifactFindFirst.mockResolvedValueOnce({ id: "artifact_winner" });

    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 1, failed: 0 });

    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "cleanup_intent_1",
        deletedAt: null,
        expiresAt,
        updatedAt,
      },
      data: { deletedAt: expect.any(Date), lastError: null },
    });
  });

  it("restores an expiry claim for durable retry when private object deletion fails", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_delete_retry",
        requestId: "wcomp_1",
        kind: "orders",
        storageKey: "compliance/delete-retry.enc",
        expiresAt,
        updatedAt,
      },
    ]);
    mocks.storageDelete.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 0, failed: 1 });

    expect(mocks.artifactUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          lastError: "storage unavailable",
        },
      }),
    );
  });

  it("recovers a stranded expiry claim when both storage deletion and DB reset fail", async () => {
    const expiresAt = new Date("2026-08-29T00:00:00.000Z");
    const updatedAt = new Date("2026-08-29T01:00:00.000Z");
    const stranded = {
      id: "artifact_stranded_claim",
      requestId: "wcomp_1",
      kind: "orders",
      storageKey: "compliance/stranded-delete.enc",
      expiresAt,
      updatedAt,
    };
    mocks.artifactFindMany.mockResolvedValue([stranded]);
    mocks.storageDelete.mockRejectedValueOnce(new Error("storage unavailable"));
    mocks.artifactUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("DB reset unavailable"))
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 0, failed: 1 });
    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:01:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 1, failed: 0 });

    expect(mocks.storageDelete).toHaveBeenCalledTimes(2);
    expect(mocks.artifactUpdateMany.mock.calls[2][0].data.lastError).toMatch(
      /^expiry-delete:/,
    );
    expect(mocks.artifactUpdateMany.mock.calls[3][0].data).toMatchObject({
      deletedAt: expect.any(Date),
      lastError: null,
    });
  });

  it("reuses the same encrypted token and reconciles every chunk expiry on delivery retry", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey: "manifest.enc",
      encryptionVersion: "aes-256-gcm:v1",
      contentSha256: "hash",
      byteSize: BigInt(1),
      expiresAt,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenCiphertext: `enc:${token}`,
      downloadTokenKeyId: "encryption-key:v1",
      downloadTokenExpiresAt: expiresAt,
      deliveredAt: null,
      downloadedAt: null,
      deletedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      request: {
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    const result = await ensureComplianceExportManifest({
      requestId: "wcomp_1",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      lease: { workerId: "worker_1", leaseVersion: 7 },
    });
    expect(result.token).toBe(token);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        requestId: "wcomp_1",
        deletedAt: null,
        expiresAt: { not: expiresAt },
        NOT: { kind: { startsWith: "upload_cleanup:" } },
      },
      data: { expiresAt },
    });
  });

  it("recovers an immutable manifest whose token publication was interrupted", async () => {
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    const incomplete = {
      id: "manifest_incomplete",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey:
        "compliance/shopify/store_1/wcomp_1/manifest-0-lease-6-winner.json.enc",
      expiresAt,
      downloadTokenHash: null,
      downloadTokenCiphertext: null,
    };
    mocks.artifactFindUnique.mockResolvedValue(incomplete);
    mocks.artifactFindUniqueOrThrow
      .mockResolvedValueOnce(incomplete)
      .mockImplementationOnce(async ({ where }) => ({ id: where.id }));

    const result = await ensureComplianceExportManifest({
      requestId: "wcomp_1",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      lease: { workerId: "worker_1", leaseVersion: 7 },
    });

    expect(result.artifact.id).toBe("manifest_incomplete");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mocks.storageUpload).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "manifest_incomplete",
          downloadTokenCiphertext: null,
        }),
        data: expect.objectContaining({
          downloadTokenHash: expect.any(String),
          downloadTokenCiphertext: expect.stringMatching(/^enc:/),
        }),
      }),
    );
  });

  it("publishes a fresh first-token deadline when an interrupted manifest is retried after expiry", async () => {
    const now = new Date("2026-09-30T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const expiredAt = new Date("2026-08-31T00:00:00.000Z");
    const incomplete = {
      id: "manifest_expired_incomplete",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey: "compliance/shopify/store_1/wcomp_1/manifest-expired.enc",
      expiresAt: expiredAt,
      downloadTokenHash: null,
      downloadTokenCiphertext: null,
    };
    mocks.artifactFindUnique.mockResolvedValue(incomplete);
    mocks.artifactFindUniqueOrThrow
      .mockResolvedValueOnce(incomplete)
      .mockImplementationOnce(async ({ where }) => ({ id: where.id }));

    await ensureComplianceExportManifest({
      requestId: "wcomp_1",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      lease: { workerId: "worker_1", leaseVersion: 7 },
    });

    const publication = mocks.artifactUpdateMany.mock.calls.find(
      ([input]) => input.where?.id === "manifest_expired_incomplete",
    )?.[0]!;
    expect(publication.data.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(publication.data.downloadTokenExpiresAt).toEqual(
      publication.data.expiresAt,
    );
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        requestId: "wcomp_1",
        deletedAt: null,
        expiresAt: { not: publication.data.expiresAt },
        NOT: { kind: { startsWith: "upload_cleanup:" } },
      },
      data: { expiresAt: publication.data.expiresAt },
    });
    dateNow.mockRestore();
  });

  it("never deletes an immutable winner when token publication is fenced", async () => {
    const incomplete = {
      id: "manifest_winner",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey:
        "compliance/shopify/store_1/wcomp_1/manifest-0-lease-6-winner.json.enc",
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      downloadTokenHash: null,
      downloadTokenCiphertext: null,
    };
    mocks.artifactFindUnique.mockResolvedValue(incomplete);
    mocks.artifactFindUniqueOrThrow.mockResolvedValueOnce(incomplete);
    mocks.artifactUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      ensureComplianceExportManifest({
        requestId: "wcomp_1",
        storeId: "store_1",
        shopDomain: "target.myshopify.com",
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("manifest publication was fenced");

    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });

  it("uses a deterministic Plain id and CASes delivery against the live request lease", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey: "manifest.enc",
      expiresAt,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenCiphertext: `enc:${token}`,
      deliveredAt: null,
    });

    await expect(
      deliverComplianceExportReference({
        requestId: "wcomp_1",
        storeId: "store_1",
        workspaceId: "workspace_1",
        shopDomain: "target.myshopify.com",
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).resolves.toMatchObject({ expiresAt });

    expect(mocks.plainCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "weletic-shopify-compliance-export:wcomp_1",
      }),
    );
    expect(mocks.artifactUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: "manifest_1",
        deletedAt: null,
        request: {
          id: "wcomp_1",
          storeId: "store_1",
          status: "processing",
          lockedBy: "worker_1",
          leaseVersion: 7,
        },
      },
      data: { deliveredAt: expect.any(Date), lastError: null },
    });
  });

  it("does not mark a deleted/revoked artifact delivered after the external-call race", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "manifest",
      sequence: 0,
      storageKey: "manifest.enc",
      expiresAt,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenCiphertext: `enc:${token}`,
      deliveredAt: null,
    });
    mocks.artifactUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      deliverComplianceExportReference({
        requestId: "wcomp_1",
        storeId: "store_1",
        workspaceId: "workspace_1",
        shopDomain: "target.myshopify.com",
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("lost its request lease");
    expect(mocks.plainCreateThread).toHaveBeenCalledOnce();
  });

  it("does not deliver an export while shop redaction is unresolved in dead-letter", async () => {
    mocks.requestFindFirst.mockImplementation(({ where }) =>
      where.id === "wcomp_1"
        ? {
            id: "wcomp_1",
            storeId: "store_1",
            subjectKind: "customer_id",
            subjectKeyId: "current-kid",
            subjectDigest: "SAFE_DIGEST",
            progress: null,
            store: { complianceState: "frozen" },
          }
        : { id: "wcomp_shop_dead_letter" },
    );

    await expect(
      deliverComplianceExportReference({
        requestId: "wcomp_1",
        storeId: "store_1",
        workspaceId: "workspace_1",
        shopDomain: "target.myshopify.com",
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("fenced by an active redaction");
    expect(mocks.requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestType: "shop_redact",
          status: {
            in: ["pending", "processing", "retrying", "dead_letter"],
          },
        }),
      }),
    );
    expect(mocks.plainCreateThread).not.toHaveBeenCalled();
  });

  it("deletes an uploaded object when the worker loses its publication fence", async () => {
    let leaseChecks = 0;
    mocks.requestFindFirst.mockImplementation(({ where }) => {
      if (where.id !== "wcomp_1") return null;
      leaseChecks += 1;
      return leaseChecks === 1
        ? {
            subjectDigest: "SAFE_DIGEST",
            progress: null,
            store: { complianceState: "active" },
          }
        : null;
    });

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "identity",
        sequence: 0,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("lease is no longer valid");

    expect(mocks.storageUpload).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: expect.stringMatching(/^upload_cleanup:/),
        }),
      }),
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: expect.stringMatching(/\/identity-0-lease-7-[a-f0-9]+\.json\.enc$/),
      bucket: "private",
    });
  });

  it("deletes uploaded ciphertext when reconciliation proves no row was published", async () => {
    mocks.artifactCreate
      .mockImplementationOnce(async ({ data }) => data)
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "orders",
        sequence: 2,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("database unavailable");

    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: expect.stringMatching(/\/orders-2-lease-7-[a-f0-9]+\.json\.enc$/),
      bucket: "private",
    });
  });

  it("serializes coupon-use BigInts exactly before private artifact encryption", async () => {
    await storeEncryptedComplianceArtifact({
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "coupon_uses",
      sequence: 0,
      value: [
        {
          id: "use_1",
          discountAmountMinor: BigInt("9007199254740993"),
          currency: "JPY",
        },
        {
          id: "use_2",
          discountAmountMinor: null,
          amountUnavailableReason: "missing_discount_applications",
        },
      ],
      expiresAt: new Date("2026-09-08T00:00:00Z"),
      lease: { workerId: "worker_1", leaseVersion: 7 },
    });
    const body = mocks.storageUpload.mock.calls[0][0].body as Buffer;
    expect(body.toString("utf8")).toBe(
      'enc:[{"id":"use_1","discountAmountMinor":"9007199254740993","currency":"JPY"},{"id":"use_2","discountAmountMinor":null,"amountUnavailableReason":"missing_discount_applications"}]',
    );
  });

  it("returns a committed artifact when the database publication response is lost", async () => {
    let committedArtifact: any;
    mocks.artifactCreate.mockImplementation(async ({ data }) => {
      if (!String(data.kind).startsWith("upload_cleanup:")) {
        committedArtifact = data;
      }
      return data;
    });
    mocks.artifactFindUnique
      .mockResolvedValueOnce(null)
      .mockImplementation(() => committedArtifact);
    mocks.transaction.mockImplementation(async (input, client) => {
      const result = typeof input === "function" ? await input(client) : input;
      if (committedArtifact) {
        throw new Error("database response lost after commit");
      }
      return result;
    });

    const artifact = await storeEncryptedComplianceArtifact({
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "orders",
      sequence: 4,
      value: { safe: true },
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      lease: { workerId: "worker_1", leaseVersion: 7 },
    });

    expect(artifact.storageKey).toBe(committedArtifact.storageKey);
    expect(mocks.storageDelete).not.toHaveBeenCalledWith({
      key: committedArtifact.storageKey,
      bucket: "private",
    });
  });

  it("retains the durable cleanup intent when publication reconciliation is unavailable", async () => {
    mocks.artifactCreate
      .mockImplementationOnce(async ({ data }) => data)
      .mockRejectedValueOnce(new Error("database publication unavailable"));
    mocks.artifactFindUnique
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("database reconciliation unavailable"));

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "orders",
        sequence: 5,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("database publication unavailable");

    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          lastError:
            "Encrypted upload publication reconciliation must be retried.",
        },
      }),
    );
  });

  it("durably retains an upload cleanup intent when an uncertain PUT cannot be deleted", async () => {
    mocks.storageUpload.mockRejectedValueOnce(
      new Error("upload response was uncertain"),
    );
    mocks.storageDelete.mockRejectedValueOnce(
      new Error("delete response was uncertain"),
    );

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "ledger",
        sequence: 6,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("upload response was uncertain");

    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.storageDelete).toHaveBeenCalledOnce();
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          lastError: "Encrypted upload cleanup must be retried.",
        },
      }),
    );
  });

  it("cannot publish after the expiry sweeper claims its upload cleanup intent", async () => {
    // The request-row lock orders these operations in production. This count=0
    // is the uploader resuming after the sweeper committed its claim.
    mocks.artifactUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "orders",
        sequence: 7,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("upload cleanup was already claimed");

    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: expect.stringMatching(/\/orders-7-lease-7-[a-f0-9]+\.json\.enc$/),
      bucket: "private",
    });
  });

  it("never publishes after an uncertain cleanup delete may already have removed the object", async () => {
    // The cleanup sweeper attempted DELETE, the object delete committed, but
    // its response was uncertain and the intent now carries a non-pristine
    // error generation. The resumed uploader must not create a pointer.
    mocks.artifactUpdateMany.mockImplementation(async ({ where, data }) => {
      if (
        where?.lastError === "Encrypted upload cleanup is pending." &&
        data?.deletedAt
      ) {
        return { count: 0 };
      }
      return { count: 1 };
    });

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "orders",
        sequence: 8,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("upload cleanup was already claimed");

    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lastError: "Encrypted upload cleanup is pending.",
        }),
      }),
    );
  });

  it("keeps the reclaimed winner object and deletes only the losing lease generation", async () => {
    let activeLeaseVersion = 7;
    let releaseLosingUpload!: () => void;
    let losingUploadStarted!: () => void;
    const losingUploadReady = new Promise<void>((resolve) => {
      losingUploadStarted = resolve;
    });
    const losingUploadGate = new Promise<void>((resolve) => {
      releaseLosingUpload = resolve;
    });
    mocks.requestFindFirst.mockImplementation(({ where }) => {
      if (!where.id) return null;
      return where.leaseVersion === activeLeaseVersion
        ? {
            id: "wcomp_1",
            storeId: "store_1",
            subjectKind: "customer_id",
            subjectKeyId: "current-kid",
            subjectDigest: "SAFE_DIGEST",
            progress: null,
            store: { complianceState: "active" },
          }
        : null;
    });
    mocks.storageUpload.mockImplementation(async ({ key }) => {
      if (key.includes("-lease-7-")) {
        losingUploadStarted();
        await losingUploadGate;
      }
    });
    mocks.artifactCreate.mockImplementation(async ({ data }) => data);

    const losingAttempt = storeEncryptedComplianceArtifact({
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "orders",
      sequence: 2,
      value: { generation: 7 },
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      lease: { workerId: "worker_7", leaseVersion: 7 },
    });
    await losingUploadReady;

    activeLeaseVersion = 8;
    const winner = await storeEncryptedComplianceArtifact({
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "orders",
      sequence: 2,
      value: { generation: 8 },
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      lease: { workerId: "worker_8", leaseVersion: 8 },
    });
    releaseLosingUpload();
    await expect(losingAttempt).rejects.toThrow("lease is no longer valid");

    expect(winner.storageKey).toContain("/orders-2-lease-8-");
    const losingKey = mocks.storageUpload.mock.calls
      .map(([input]) => input.key as string)
      .find((key) => key.includes("-lease-7-"));
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: losingKey,
      bucket: "private",
    });
    expect(mocks.storageDelete).not.toHaveBeenCalledWith({
      key: winner.storageKey,
      bucket: "private",
    });
  });

  it("treats a logical artifact as immutable and garbage-collects a retry upload", async () => {
    const existing = {
      id: "artifact_winner",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "identity",
      sequence: 0,
      storageKey:
        "compliance/shopify/store_1/wcomp_1/identity-0-lease-7-winner.json.enc",
    };
    mocks.artifactFindUnique.mockResolvedValue(existing);

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "identity",
        sequence: 0,
        value: { regenerated: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).resolves.toBe(existing);

    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    const retryKey = mocks.storageUpload.mock.calls[0][0].key;
    expect(retryKey).not.toBe(existing.storageKey);
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: retryKey,
      bucket: "private",
    });
    expect(mocks.storageDelete).not.toHaveBeenCalledWith({
      key: existing.storageKey,
      bucket: "private",
    });
  });

  it("keeps a losing upload cleanup live until a failed object delete is retried", async () => {
    const existing = {
      id: "artifact_winner",
      requestId: "wcomp_1",
      storeId: "store_1",
      kind: "identity",
      sequence: 0,
      storageKey: "compliance/shopify/store_1/wcomp_1/winner.enc",
    };
    mocks.artifactFindUnique.mockResolvedValue(existing);
    mocks.storageDelete.mockRejectedValueOnce(
      new Error("loser object delete unavailable"),
    );

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "identity",
        sequence: 0,
        value: { regenerated: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).resolves.toBe(existing);

    const cleanup = mocks.artifactCreate.mock.calls[0][0].data;
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: cleanup.id, deletedAt: null },
        data: { lastError: "Encrypted upload cleanup must be retried." },
      }),
    );

    mocks.artifactFindMany.mockResolvedValueOnce([
      {
        id: cleanup.id,
        requestId: "wcomp_1",
        kind: cleanup.kind,
        storageKey: cleanup.storageKey,
        expiresAt: cleanup.expiresAt,
        updatedAt: new Date("2026-08-29T01:00:00.000Z"),
      },
    ]);
    mocks.artifactFindFirst.mockResolvedValueOnce(null);
    await expect(
      deleteExpiredComplianceArtifactsBatch({
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ selected: 1, deleted: 1, failed: 0 });
    expect(mocks.storageDelete).toHaveBeenLastCalledWith({
      key: cleanup.storageKey,
      bucket: "private",
    });
  });

  it("deletes an in-flight upload when shop erasure raises its publication fence", async () => {
    let blockerChecks = 0;
    mocks.requestFindFirst.mockImplementation(({ where }) => {
      if (where.id === "wcomp_1") {
        return {
          subjectDigest: "SAFE_DIGEST",
          progress: null,
          store: { complianceState: "frozen" },
        };
      }
      blockerChecks += 1;
      return blockerChecks === 1 ? null : { id: "wcomp_shop_redact" };
    });

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "ledger",
        sequence: 3,
        value: { retained: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("fenced by an active redaction");

    expect(mocks.storageUpload).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.storageDelete).toHaveBeenCalledWith({
      key: expect.stringMatching(/\/ledger-3-lease-7-[a-f0-9]+\.json\.enc$/),
      bucket: "private",
    });
  });

  it("fences a previous-key pending export against a rotated customer redaction", async () => {
    mocks.requestFindFirst.mockImplementation(({ where }) =>
      where.id === "wcomp_1"
        ? {
            subjectKind: "customer_id",
            subjectKeyId: "previous-kid",
            subjectDigest: "PREVIOUS_DIGEST",
            progress: null,
            store: { complianceState: "active" },
          }
        : null,
    );
    mocks.requestFindMany.mockResolvedValue([
      {
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "CURRENT_DIGEST",
        payloadCiphertext: 'enc:{"customerId":"42","orderExternalIds":[]}',
        progress: null,
      },
    ]);
    mocks.deriveIdentities.mockReturnValue([
      {
        identityKind: "customer_id",
        identityKeyId: "current-kid",
        customerDigest: "CURRENT_DIGEST",
      },
      {
        identityKind: "customer_id",
        identityKeyId: "previous-kid",
        customerDigest: "PREVIOUS_DIGEST",
      },
    ]);

    await expect(
      storeEncryptedComplianceArtifact({
        requestId: "wcomp_1",
        storeId: "store_1",
        kind: "identity",
        sequence: 0,
        value: { safe: true },
        expiresAt: new Date("2026-08-31T00:00:00.000Z"),
        lease: { workerId: "worker_1", leaseVersion: 7 },
      }),
    ).rejects.toThrow("fenced by an active redaction");
    expect(mocks.storageUpload).not.toHaveBeenCalled();
    expect(mocks.artifactCreate).not.toHaveBeenCalled();
  });

  it("boundedly erases only exports superseded by one customer redaction", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: "artifact_1", storageKey: "compliance/customer.enc" },
    ]);

    const result = await deleteComplianceArtifactsForCustomerRedactionBatch({
      storeId: "store_1",
      supersededPhase: "superseded_by_customer_redact:wcomp_redact",
      batchSize: 10,
    });

    expect(result).toEqual({ selected: 1, deleted: 1, failed: 0 });
    expect(mocks.artifactFindMany).toHaveBeenCalledWith({
      where: {
        storeId: "store_1",
        deletedAt: null,
        request: {
          phase: "superseded_by_customer_redact:wcomp_redact",
        },
      },
      orderBy: { id: "asc" },
      take: 10,
      select: { id: true, storageKey: true },
    });
  });

  it("streams decrypted chunks from bounded artifact pages", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const ciphertext = 'enc:{"member":"safe-export"}';
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: createHash("sha256").update(ciphertext).digest("hex"),
      request: {
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_1",
        kind: "identity",
        sequence: 0,
        storageKey: "identity.enc",
        contentSha256: createHash("sha256").update(ciphertext).digest("hex"),
      },
    ]);
    mocks.signedDownload.mockResolvedValue("https://storage.test/signed");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(ciphertext, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );

    const download = await createComplianceExportDownload({
      requestId: "wcomp_1",
      token,
    });
    expect(download).not.toBeNull();
    await expect(new Response(download!.body).json()).resolves.toEqual({
      requestId: "wcomp_1",
      chunks: [
        { kind: "identity", sequence: 0, data: { member: "safe-export" } },
      ],
    });
    expect(mocks.artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { id: "asc" } }),
    );
    expect(mocks.artifactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "manifest_1" },
        data: { downloadedAt: expect.any(Date) },
      }),
    );
  });

  it("rejects a valid bearer immediately after its request is superseded", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: "hash",
      request: {
        phase: "superseded_by_customer_redact:wcomp_redact",
        store: { complianceState: "active" },
      },
    });

    await expect(
      createComplianceExportDownload({ requestId: "wcomp_1", token }),
    ).resolves.toBeNull();
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });

  it("rejects a valid bearer as soon as shop redaction is pending", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: "hash",
      request: {
        id: "wcomp_1",
        storeId: "store_1",
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "SAFE_DIGEST",
        progress: { ownerShopperId: "shopper_1" },
        phase: "completed",
        store: { complianceState: "frozen" },
      },
    });
    mocks.requestFindFirst.mockResolvedValue({ id: "wcomp_shop_redact" });

    await expect(
      createComplianceExportDownload({ requestId: "wcomp_1", token }),
    ).resolves.toBeNull();
    expect(mocks.requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_1",
          requestType: "shop_redact",
          status: {
            in: ["pending", "processing", "retrying", "dead_letter"],
          },
        }),
      }),
    );
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });

  it("rejects a valid bearer while its matching customer redaction is pending", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: "hash",
      request: {
        id: "wcomp_1",
        storeId: "store_1",
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "SAFE_DIGEST",
        progress: { ownerShopperId: "shopper_1" },
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    mocks.requestFindFirst.mockResolvedValue(null);
    mocks.requestFindMany.mockResolvedValue([
      {
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "SAFE_DIGEST",
        payloadCiphertext: null,
        progress: null,
      },
    ]);

    await expect(
      createComplianceExportDownload({ requestId: "wcomp_1", token }),
    ).resolves.toBeNull();
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_1",
          requestType: "customer_redact",
          status: {
            in: ["pending", "processing", "retrying", "dead_letter"],
          },
        }),
        take: 51,
      }),
    );
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });

  it("rejects a valid bearer while matching customer redaction is unresolved in dead-letter", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: "hash",
      request: {
        id: "wcomp_1",
        storeId: "store_1",
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "SAFE_DIGEST",
        progress: null,
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    mocks.requestFindFirst.mockResolvedValue(null);
    mocks.requestFindMany.mockResolvedValue([
      {
        subjectKind: "customer_id",
        subjectKeyId: "current-kid",
        subjectDigest: "SAFE_DIGEST",
        payloadCiphertext: null,
        progress: null,
      },
    ]);

    await expect(
      createComplianceExportDownload({ requestId: "wcomp_1", token }),
    ).resolves.toBeNull();
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestType: "customer_redact",
          status: {
            in: ["pending", "processing", "retrying", "dead_letter"],
          },
        }),
      }),
    );
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });

  it.each(["pending", "dead_letter"])(
    "fails closed for a scrubbed completed export while an identity-unresolved customer redaction is %s",
    async (redactionStatus) => {
      const token = "stable-private-token-value-12345678901234567890";
      const expiresAt = new Date(Date.now() + 60_000);
      mocks.artifactFindUnique.mockResolvedValue({
        id: "manifest_1",
        requestId: "wcomp_completed_scrubbed",
        downloadTokenHash: createHash("sha256").update(token).digest("hex"),
        downloadTokenExpiresAt: expiresAt,
        expiresAt,
        deletedAt: null,
        storageKey: "manifest.enc",
        contentSha256: "hash",
        request: {
          id: "wcomp_completed_scrubbed",
          storeId: "store_1",
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          progress: null,
          phase: "completed",
          store: { complianceState: "active" },
        },
      });
      mocks.requestFindFirst.mockResolvedValue(null);
      mocks.requestFindMany.mockResolvedValue([
        {
          subjectKind: "customer_id",
          subjectKeyId: "current-kid",
          subjectDigest: "NEW_REDACTION_DIGEST",
          payloadCiphertext: 'enc:{"customerId":"42"}',
          progress: null,
        },
      ]);

      await expect(
        createComplianceExportDownload({
          requestId: "wcomp_completed_scrubbed",
          token,
        }),
      ).resolves.toBeNull();
      expect(mocks.requestFindMany.mock.calls[0][0].where.status.in).toContain(
        redactionStatus,
      );
      expect(mocks.signedDownload).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "dead_letter"])(
    "fails closed for an owner-bearing completed export when a digest-only customer redaction is %s",
    async (redactionStatus) => {
      const token = "stable-private-token-value-12345678901234567890";
      const expiresAt = new Date(Date.now() + 60_000);
      mocks.artifactFindUnique.mockResolvedValue({
        id: "manifest_owner_bearing",
        requestId: "wcomp_owner_bearing",
        downloadTokenHash: createHash("sha256").update(token).digest("hex"),
        downloadTokenExpiresAt: expiresAt,
        expiresAt,
        deletedAt: null,
        storageKey: "manifest.enc",
        contentSha256: "hash",
        request: {
          id: "wcomp_owner_bearing",
          storeId: "store_1",
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          progress: { ownerShopperId: "shopper_export" },
          phase: "completed",
          store: { complianceState: "active" },
        },
      });
      mocks.requestFindFirst.mockResolvedValue(null);
      mocks.requestFindMany.mockResolvedValue([
        {
          subjectKind: "customer_id",
          subjectKeyId: "current-kid",
          subjectDigest: "REDACTION_DIGEST",
          payloadCiphertext: 'enc:{"customerId":"42"}',
          progress: null,
        },
      ]);

      await expect(
        createComplianceExportDownload({
          requestId: "wcomp_owner_bearing",
          token,
        }),
      ).resolves.toBeNull();
      expect(mocks.requestFindMany.mock.calls[0][0].where.status.in).toContain(
        redactionStatus,
      );
      expect(mocks.signedDownload).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "dead_letter"])(
    "fails closed for a legacy-owner export when a shopper-owner redaction is %s",
    async (redactionStatus) => {
      const token = "stable-private-token-value-12345678901234567890";
      const expiresAt = new Date(Date.now() + 60_000);
      mocks.artifactFindUnique.mockResolvedValue({
        id: "manifest_legacy_owner",
        requestId: "wcomp_legacy_owner",
        downloadTokenHash: createHash("sha256").update(token).digest("hex"),
        downloadTokenExpiresAt: expiresAt,
        expiresAt,
        deletedAt: null,
        storageKey: "manifest.enc",
        contentSha256: "hash",
        request: {
          id: "wcomp_legacy_owner",
          storeId: "store_1",
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          progress: { ownerLegacyCustomerId: "legacy_customer_1" },
          phase: "completed",
          store: { complianceState: "active" },
        },
      });
      mocks.requestFindFirst.mockResolvedValue(null);
      mocks.requestFindMany.mockResolvedValue([
        {
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          payloadCiphertext: null,
          progress: { ownerShopperId: "shopper_1" },
        },
      ]);

      await expect(
        createComplianceExportDownload({
          requestId: "wcomp_legacy_owner",
          token,
        }),
      ).resolves.toBeNull();
      expect(mocks.requestFindMany.mock.calls[0][0].where.status.in).toContain(
        redactionStatus,
      );
      expect(mocks.signedDownload).not.toHaveBeenCalled();
    },
  );

  it("keeps an owner-bearing export readable when an active redaction has a conclusively different owner", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const ciphertext = 'enc:{"member":"unrelated-export"}';
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_unrelated_owner",
      requestId: "wcomp_unrelated_owner",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: createHash("sha256").update(ciphertext).digest("hex"),
      request: {
        id: "wcomp_unrelated_owner",
        storeId: "store_1",
        subjectKind: null,
        subjectKeyId: null,
        subjectDigest: null,
        progress: { ownerShopperId: "shopper_export" },
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    mocks.requestFindFirst.mockResolvedValue(null);
    mocks.requestFindMany.mockResolvedValue([
      {
        subjectKind: null,
        subjectKeyId: null,
        subjectDigest: null,
        payloadCiphertext: null,
        progress: { ownerShopperId: "shopper_other" },
      },
    ]);
    mocks.artifactFindMany.mockResolvedValue([
      {
        id: "artifact_unrelated_owner",
        kind: "identity",
        sequence: 0,
        storageKey: "identity.enc",
        contentSha256: createHash("sha256").update(ciphertext).digest("hex"),
      },
    ]);
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_unrelated_owner",
      storeId: "store_1",
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
      progress: { ownerShopperId: "shopper_export" },
      phase: "completed",
      store: { complianceState: "active" },
    });
    mocks.signedDownload.mockResolvedValue("https://storage.test/signed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ciphertext)));

    const download = await createComplianceExportDownload({
      requestId: "wcomp_unrelated_owner",
      token,
    });
    expect(download).not.toBeNull();
    await expect(new Response(download!.body).json()).resolves.toEqual(
      expect.objectContaining({ requestId: "wcomp_unrelated_owner" }),
    );
  });

  it("rechecks revocation before fetching each encrypted stream chunk", async () => {
    const token = "stable-private-token-value-12345678901234567890";
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.artifactFindUnique.mockResolvedValue({
      id: "manifest_1",
      requestId: "wcomp_1",
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadTokenExpiresAt: expiresAt,
      expiresAt,
      deletedAt: null,
      storageKey: "manifest.enc",
      contentSha256: "hash",
      request: {
        phase: "completed",
        store: { complianceState: "active" },
      },
    });
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_1",
      storeId: "store_1",
      subjectKind: "customer_id",
      subjectKeyId: "current-kid",
      subjectDigest: "SAFE_DIGEST",
      progress: { ownerShopperId: "shopper_1" },
      phase: "superseded_by_customer_redact:wcomp_redact",
      store: { complianceState: "active" },
    });

    const download = await createComplianceExportDownload({
      requestId: "wcomp_1",
      token,
    });
    expect(download).not.toBeNull();
    await expect(new Response(download!.body).text()).rejects.toThrow(
      "access has been revoked",
    );
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });
});
