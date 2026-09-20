import { ReviewError } from "@/lib/weletic/reviews/contracts";
import {
  InvalidOpenReviewPhoto,
  OpenPhotoReconciliationRequired,
} from "@/lib/weletic/reviews/open-media-errors";
import { uploadOpenReviewPhoto } from "@/lib/weletic/reviews/open-media-upload";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  policy: vi.fn(),
  author: vi.fn(),
  normalize: vi.fn(),
  storageCheck: vi.fn(),
  reserve: vi.fn(),
  claim: vi.fn(),
  outcome: vi.fn(),
  upload: vi.fn(),
  authorize: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  settlement: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/reviews/open-media-reconciliation", () => ({
  reconcileOpenReviewPhotoStorage: mocks.reconcile,
}));
vi.mock("@/lib/storage", () => ({ storage: { upload: mocks.upload } }));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: mocks.fence,
}));
vi.mock("@/lib/weletic/reviews/open-policy-history", () => ({
  readCurrentOpenReviewPolicy: mocks.policy,
}));
vi.mock("@/lib/weletic/reviews/open-submission-author", () => ({
  ensureOpenReviewAuthorInTransaction: mocks.author,
}));
vi.mock("@/lib/weletic/reviews/media", () => ({
  normalizeReviewPhoto: mocks.normalize,
  requireReviewStorage: mocks.storageCheck,
}));
vi.mock("@/lib/weletic/reviews/open-media-reservation", () => ({
  reserveOpenReviewPhotoInTransaction: mocks.reserve,
}));
vi.mock("@/lib/weletic/reviews/open-media-write-state", () => ({
  claimOpenPhotoStorageWrite: mocks.claim,
  recordOpenPhotoStorageOutcome: mocks.outcome,
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.lock,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: mocks.settlement,
}));
const input = {
  submissionId: "12345678-1234-4123-8123-123456789012",
  uploadId: "12345678-1234-4123-8123-123456789013",
  productId: "gid://shopify/Product/123",
  expectedInstallationGeneration: "g1",
  expectedSettingsRevision: 1,
  contentType: "image/png",
};
const tx = {
  $queryRaw: mocks.query,
  weleticShopifyStore: {
    findUniqueOrThrow: async () => ({ projectId: "workspace" }),
  },
  weleticReviewMedia: { updateMany: mocks.update },
};
const photo = {
  id: "wrevmedia_photo",
  objectKey: "weletic/reviews/store/wrevmedia_photo.webp",
  uploadExpiresAt: new Date("2026-09-21T00:00:00Z"),
  reviewId: null,
};
let state: string;
let status: string;
it.each([0, 2 * 1024 * 1024 + 1])(
  "rejects normalized size %s before reservation or PUT",
  async (size) => {
    mocks.normalize.mockResolvedValue(Buffer.alloc(size));
    await expect(run()).rejects.toBeInstanceOf(InvalidOpenReviewPhoto);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  },
);
it("marks only pre-reservation image validation failure as safe to correct", async () => {
  mocks.normalize.mockRejectedValue(
    new ReviewError("bad_request", "invalid bytes"),
  );
  await expect(run()).rejects.toBeInstanceOf(InvalidOpenReviewPhoto);
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  mocks.normalize.mockRejectedValue(new Error("unexpected decoder failure"));
  await expect(run()).rejects.not.toBeInstanceOf(InvalidOpenReviewPhoto);
});
const run = (patch = {}) =>
  uploadOpenReviewPhoto({
    storeId: "store",
    installationGeneration: "g1",
    input: { ...input, ...patch },
    bytes: Buffer.from("raw"),
    authorize: mocks.authorize,
  });
beforeEach(() => {
  vi.resetAllMocks();
  state = "not_started";
  status = "reserved";
  mocks.reconcile.mockResolvedValue({ status: "unresolved" });
  mocks.fence.mockImplementation((_store, fn) => fn(tx));
  mocks.transaction.mockImplementation((fn) => fn(tx));
  mocks.lock.mockImplementation(({ fn }) => fn());
  mocks.settlement.mockImplementation(({ fn }) => fn());
  mocks.authorize.mockResolvedValue({
    shopifyCustomerId: "123",
    email: null,
    source: "app_proxy",
  });
  mocks.author.mockResolvedValue({ shopperId: "shopper" });
  mocks.policy.mockResolvedValue({
    revision: 1,
    installationGeneration: "g1",
    policy: {
      enabled: true,
      photoUploadsEnabled: true,
      maxSubmissionsPer24Hours: 3,
    },
  });
  mocks.normalize.mockResolvedValue(Buffer.from("normalized"));
  mocks.query.mockImplementation((sql: Prisma.Sql) => {
    const text = sql.strings.join("?");
    if (text.includes("WeleticReviewSettings"))
      return [{ photoUploadsEnabled: true }];
    if (text.includes("WeleticShopifyProduct")) return [{ id: "product" }];
    throw new Error("Unexpected query");
  });
  mocks.reserve.mockImplementation(() => {
    if (["in_flight", "ambiguous"].includes(state))
      throw new OpenPhotoReconciliationRequired(photo.id);
    return { ...photo, status, storageWriteState: state };
  });
  mocks.claim.mockImplementation(() => {
    state = "in_flight";
  });
  mocks.outcome.mockImplementation((_tx, _store, _id, _token, outcome) => {
    state = outcome;
  });
  mocks.update.mockImplementation(() => {
    status = "uploaded";
    return { count: 1 };
  });
});
it("reauthorizes around decoding/PUT, claims once, and finalizes without exposing ownership", async () => {
  expect(await run()).toEqual({ id: photo.id });
  expect(mocks.settlement).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: "store",
      workspaceId: "workspace",
      shopifyCustomerId: "123",
    }),
  );
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      key: `weletic:reviews:media:store:${photo.id}`,
      ttlSeconds: 300,
    }),
  );
  expect(mocks.upload).toHaveBeenCalledWith({
    key: photo.objectKey,
    bucket: "private",
    body: Buffer.from("normalized"),
    opts: {
      contentType: "image/webp",
      singleAttempt: true,
      headers: {
        "x-amz-meta-weletic-upload-proof":
          expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      signal: expect.any(AbortSignal),
    },
  });
  expect(mocks.claim).toHaveBeenCalledWith(
    tx,
    "store",
    photo.id,
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.upload.mock.invocationCallOrder[0],
  );
  expect(mocks.outcome.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.update.mock.invocationCallOrder[0],
  );
  expect(state).toBe("confirmed");
  expect(status).toBe("uploaded");
  expect(mocks.authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
});
it("replays confirmed uploads without a second private PUT", async () => {
  await run();
  await run();
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.claim).toHaveBeenCalledTimes(1);
});
it("resumes confirmed PUT after a failed SQL finalization without uploading again", async () => {
  mocks.update.mockRejectedValueOnce(new Error("SQL unavailable"));
  await expect(run()).rejects.toMatchObject({ code: "unavailable" });
  expect(state).toBe("confirmed");
  expect(status).toBe("reserved");
  expect(await run()).toEqual({ id: photo.id });
  expect(mocks.upload).toHaveBeenCalledTimes(1);
});
it("preserves committed finalization when its database response is lost", async () => {
  mocks.update.mockImplementationOnce(() => {
    status = "uploaded";
    throw new Error("committed reply lost");
  });
  await expect(run()).rejects.toMatchObject({ code: "unavailable" });
  expect(state).toBe("confirmed");
  expect(await run()).toEqual({ id: photo.id });
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
it("contains ambiguous provider outcomes and never resubmits their PUT", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("timeout after dispatch"));
  await expect(run()).rejects.toThrow("requires reconciliation");
  expect(state).toBe("ambiguous");
  expect(status).toBe("reserved");
  await expect(run()).rejects.toThrow("requires reconciliation");
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.update).not.toHaveBeenCalled();
});
it("recovers an exact authenticated retry from positive evidence without another PUT", async () => {
  state = "ambiguous";
  mocks.reconcile.mockImplementation(async () => {
    state = "confirmed";
    return { status: "confirmed" };
  });
  expect(await run()).toEqual({ id: photo.id });
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith("store", photo.id);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
it("sanitizes reconciliation failures and does not finalize or retry PUT", async () => {
  state = "ambiguous";
  mocks.reconcile.mockRejectedValue(new Error("private provider diagnostics"));
  await expect(run()).rejects.toMatchObject({
    code: "unavailable",
    message: "Photo storage outcome requires reconciliation",
  });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});
it("does not reconcile denied or changed upload evidence", async () => {
  mocks.reserve.mockRejectedValue(
    new ReviewError("conflict", "Upload identity already used"),
  );
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("rechecks policy and privacy after remote recovery, without restoring author/content", async () => {
  state = "ambiguous";
  mocks.reconcile.mockImplementation(async () => {
    state = "confirmed";
    mocks.author.mockRejectedValue(
      new ReviewError("not_found", "Shopper unavailable"),
    );
    return { status: "confirmed" };
  });
  await expect(run()).rejects.toMatchObject({ code: "not_found" });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});
it("keeps in-flight containment if recording the successful remote outcome fails", async () => {
  mocks.outcome.mockRejectedValueOnce(new Error("database reply lost"));
  await expect(run()).rejects.toThrow("database reply lost");
  expect(state).toBe("in_flight");
  await expect(run()).rejects.toThrow("requires reconciliation");
  expect(mocks.upload).toHaveBeenCalledTimes(1);
});
it("denied/stale policy and changed identity stop before image work", async () => {
  await expect(run({ expectedSettingsRevision: 2 })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(mocks.normalize).not.toHaveBeenCalled();
  mocks.authorize
    .mockResolvedValueOnce({
      shopifyCustomerId: "123",
      email: null,
      source: "app_proxy",
    })
    .mockResolvedValue({
      shopifyCustomerId: "456",
      email: null,
      source: "app_proxy",
    });
  await expect(run()).rejects.toMatchObject({ code: "conflict" });
  expect(mocks.normalize).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("revocation after PUT prevents publication but retains truthful completed-write evidence", async () => {
  mocks.upload.mockImplementation(() => {
    mocks.policy.mockResolvedValue({
      revision: 2,
      installationGeneration: "g1",
      policy: { enabled: false, photoUploadsEnabled: false },
    });
  });
  await expect(run()).rejects.toMatchObject({ code: "unavailable" });
  expect(state).toBe("confirmed");
  expect(status).toBe("reserved");
  expect(mocks.update).not.toHaveBeenCalled();
});
