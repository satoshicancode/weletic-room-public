import { backfillReviewOwnerPrivacyPage } from "@/lib/weletic/reviews/privacy-owner-backfill";
import { reviewPrivacyKeySetDigest } from "@/lib/weletic/reviews/privacy-owner-contract";
import { ReviewOwnerPrivacySuppressedError } from "@/lib/weletic/reviews/privacy-owner-write";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owners: vi.fn(),
  guard: vi.fn(),
  replace: vi.fn(),
  redact: vi.fn(),
  keys: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        weleticShopper: { findMany: mocks.owners },
        weleticReviewPrivacyBackfillAudit: { create: mocks.audit },
      }),
  },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", async (original) => ({
  ...(await original<object>()),
  loadShopifyPrivacyHmacKeyring: mocks.keys,
}));
vi.mock("@/lib/weletic/reviews/privacy-owner-write", async (original) => ({
  ...(await original<object>()),
  replaceReviewOwnerPrivacyProjection: mocks.replace,
}));
vi.mock("@/lib/weletic/reviews/privacy-owner-redact", () => ({
  redactReviewOwnerPrivacyProjection: mocks.redact,
}));
const key = { identityKeyId: "fixture", secret: Buffer.alloc(32, 9) };
const keyring = { current: key, all: [key] };
const scope = {
  storeId: "store-a",
  installationGeneration: "g1",
  keySetDigest: reviewPrivacyKeySetDigest(keyring),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.keys.mockReturnValue(keyring);
  mocks.guard.mockResolvedValue({});
  mocks.owners.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
  mocks.replace.mockResolvedValue({ identityCount: 2 });
});
const audit = {
  runId: "6cfbe2b9-a0ae-4a20-a3c2-85392075b98e",
  operatorReference: "operator_fixture",
};
it("previews a bounded selection without projection or audit writes", async () => {
  const result = await backfillReviewOwnerPrivacyPage({
    ...scope,
    limit: 2,
    dryRun: true,
  });
  expect(result.preview).toEqual({
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    selected: 2,
    hasMore: true,
  });
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.redact).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(scope.keySetDigest);
});
it("requires the same selected batch when an expected preview is supplied", async () => {
  const preview = await backfillReviewOwnerPrivacyPage({
    ...scope,
    limit: 2,
    dryRun: true,
  });
  const expectedPreviewDigest = preview.preview!.digest;
  mocks.owners.mockResolvedValue([{ id: "a" }, { id: "new" }, { id: "c" }]);
  await expect(
    backfillReviewOwnerPrivacyPage({
      ...scope,
      limit: 2,
      audit,
      expectedPreviewDigest,
    }),
  ).rejects.toThrow("preview changed");
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  mocks.owners.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
  await expect(
    backfillReviewOwnerPrivacyPage({
      ...scope,
      limit: 2,
      audit,
      expectedPreviewDigest,
    }),
  ).resolves.toMatchObject({ projected: 2 });
});
it("records private count-only evidence for both outcomes", async () => {
  mocks.owners.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  mocks.replace
    .mockResolvedValueOnce({ identityCount: 2 })
    .mockRejectedValueOnce(new ReviewOwnerPrivacySuppressedError());
  await backfillReviewOwnerPrivacyPage({ ...scope, audit });
  expect(mocks.audit.mock.calls.map(([input]) => input.data.outcome)).toEqual([
    "projected",
    "suppressed",
  ]);
  for (const [input] of mocks.audit.mock.calls) {
    expect(input.data).toEqual({
      id: expect.any(String),
      ...audit,
      storeId: scope.storeId,
      installationGeneration: scope.installationGeneration,
      outcome: expect.stringMatching(/^(projected|suppressed)$/),
    });
  }
});
it("propagates audit failure and stops before another owner", async () => {
  mocks.audit.mockRejectedValue(new Error("audit unavailable"));
  await expect(
    backfillReviewOwnerPrivacyPage({ ...scope, audit }),
  ).rejects.toThrow("audit unavailable");
  expect(mocks.replace).toHaveBeenCalledTimes(1);
  expect(mocks.redact).not.toHaveBeenCalled();
});
it("rejects free-text operator identities before SQL", async () => {
  await expect(
    backfillReviewOwnerPrivacyPage({
      ...scope,
      audit: { ...audit, operatorReference: "private@example.test" },
    }),
  ).rejects.toThrow("audit context invalid");
  expect(mocks.owners).not.toHaveBeenCalled();
});
it("bounds writes and returns a private scope-bound checkpoint without source identities", async () => {
  expect(await backfillReviewOwnerPrivacyPage({ ...scope, limit: 2 })).toEqual({
    projected: 2,
    suppressed: 0,
    checkpoint: { ...scope, afterShopperId: "b" },
  });
  expect(mocks.owners).toHaveBeenCalledWith({
    where: {
      storeId: "store-a",
      OR: [
        { nativeReviews: { some: { storeId: "store-a" } } },
        { reviewRequests: { some: { storeId: "store-a" } } },
        { storeReviews: { some: { storeId: "store-a" } } },
        { storeReviewRequests: { some: { storeId: "store-a" } } },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 3,
  });
  expect(mocks.replace.mock.calls.map(([input]) => input.shopperId)).toEqual([
    "a",
    "b",
  ]);
});
it("resumes after the exact owner and ends without claiming store readiness", async () => {
  mocks.owners.mockResolvedValue([{ id: "c" }]);
  expect(
    await backfillReviewOwnerPrivacyPage({
      ...scope,
      limit: 2,
      checkpoint: { ...scope, afterShopperId: "b" },
    }),
  ).toEqual({ projected: 1, suppressed: 0, checkpoint: null });
  expect(mocks.owners.mock.calls[0][0].where.id).toEqual({ gt: "b" });
});
it.each([0, 101, 1.5])(
  "rejects invalid batch size %s before accessing SQL",
  async (limit) => {
    await expect(
      backfillReviewOwnerPrivacyPage({ ...scope, limit }),
    ).rejects.toThrow("scope invalid");
    expect(mocks.owners).not.toHaveBeenCalled();
  },
);
it("rejects cross-store checkpoints before SQL", async () => {
  await expect(
    backfillReviewOwnerPrivacyPage({
      ...scope,
      checkpoint: { ...scope, storeId: "foreign", afterShopperId: "a" },
    }),
  ).rejects.toThrow("checkpoint mismatch");
  expect(mocks.owners).not.toHaveBeenCalled();
});
it("contains only typed authoritative suppression", async () => {
  mocks.owners.mockResolvedValue([{ id: "a" }]);
  mocks.replace.mockRejectedValue(new ReviewOwnerPrivacySuppressedError());
  expect(await backfillReviewOwnerPrivacyPage(scope)).toEqual({
    projected: 0,
    suppressed: 1,
    checkpoint: null,
  });
  expect(mocks.redact).toHaveBeenCalledWith(
    expect.objectContaining({ storeId: "store-a", shopperId: "a" }),
  );
});
it("does not misclassify database failures as privacy erasure", async () => {
  mocks.replace.mockRejectedValue(new Error("synthetic database error"));
  await expect(backfillReviewOwnerPrivacyPage(scope)).rejects.toThrow(
    "synthetic database error",
  );
  expect(mocks.redact).not.toHaveBeenCalled();
});
it("rechecks keys before every owner and aborts if material changes under the same id", async () => {
  const changed = { ...key, secret: Buffer.alloc(32, 8) };
  mocks.keys
    .mockReturnValueOnce(keyring)
    .mockReturnValueOnce(keyring)
    .mockReturnValue({ current: changed, all: [changed] });
  await expect(
    backfillReviewOwnerPrivacyPage({ ...scope, limit: 2 }),
  ).rejects.toThrow("key set changed");
  expect(mocks.replace).toHaveBeenCalledTimes(1);
  expect(mocks.redact).not.toHaveBeenCalled();
});
