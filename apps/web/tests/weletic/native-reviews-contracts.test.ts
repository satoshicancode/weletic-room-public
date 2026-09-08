import {
  generateReviewToken,
  hashReviewToken,
  hasUnrefundedReviewQuantity,
  REVIEW_MAX_PHOTO_BYTES,
  reviewSubmissionSchema,
} from "@/lib/weletic/reviews/contracts";
import { normalizeReviewPhoto } from "@/lib/weletic/reviews/media";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/storage", () => ({ storage: {} }));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({ enqueueOutboxJob: vi.fn() }));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
vi.mock("@/lib/weletic/redis-lock", () => ({ withDistributedLock: vi.fn() }));

describe("native review contracts", () => {
  it("uses independent 256-bit bearer tokens and SHA-256-only lookup", () => {
    const first = generateReviewToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateReviewToken()).not.toBe(first);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(hashReviewToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashReviewToken(first)).not.toContain(first);
    expect(() => hashReviewToken("short")).toThrow("unavailable");
  });
  it("accepts low ratings, unicode text and nanoid photo identifiers without changing rewards", () => {
    expect(
      reviewSubmissionSchema.parse({
        token: generateReviewToken(),
        rating: 1,
        title: "Honest feedback",
        body: "The product did not meet my expectations.",
        displayName: "Nguyễn",
        mediaIds: ["wrevmedia_A-b_c"],
        publishConsent: true,
      }).rating,
    ).toBe(1);
  });
  it("requires consent and rejects duplicate or excessive photos and unknown fields", () => {
    const valid = {
      token: generateReviewToken(),
      rating: 5,
      title: "Good product",
      body: "This is my genuine review of the product.",
      displayName: "Buyer",
      publishConsent: true,
    };
    expect(
      reviewSubmissionSchema.safeParse({ ...valid, publishConsent: false })
        .success,
    ).toBe(false);
    expect(
      reviewSubmissionSchema.safeParse({
        ...valid,
        mediaIds: ["wrevmedia_a", "wrevmedia_a"],
      }).success,
    ).toBe(false);
    expect(
      reviewSubmissionSchema.safeParse({ ...valid, storeId: "another-store" })
        .success,
    ).toBe(false);
    expect(
      reviewSubmissionSchema.safeParse({
        ...valid,
        mediaIds: Array.from({ length: 6 }, (_, i) => `wrevmedia_${i}`),
      }).success,
    ).toBe(false);
  });
  it("retains partially refunded quantities but excludes full quantity/amount refunds", () => {
    const line = {
      purchasedQuantity: 3,
      orderLine: {
        quantity: 3,
        shopNet: BigInt(900),
        refundLines: [{ quantity: 1, shopAmount: BigInt(300) }],
      },
    };
    expect(hasUnrefundedReviewQuantity([line])).toBe(true);
    expect(
      hasUnrefundedReviewQuantity([
        {
          ...line,
          orderLine: {
            ...line.orderLine,
            refundLines: [{ quantity: 3, shopAmount: BigInt(300) }],
          },
        },
      ]),
    ).toBe(false);
    expect(
      hasUnrefundedReviewQuantity([
        {
          ...line,
          orderLine: {
            ...line.orderLine,
            refundLines: [{ quantity: 1, shopAmount: BigInt(900) }],
          },
        },
      ]),
    ).toBe(false);
    expect(hasUnrefundedReviewQuantity([])).toBe(false);
  });
  it("does not let increased current quantity expand the fulfilled purchase binding", () => {
    expect(
      hasUnrefundedReviewQuantity([
        {
          purchasedQuantity: 1,
          orderLine: {
            quantity: 10,
            shopNet: BigInt(1000),
            refundLines: [{ quantity: 1, shopAmount: BigInt(100) }],
          },
        },
      ]),
    ).toBe(false);
  });
  it("decodes, strips metadata, resizes and re-encodes genuine photos", async () => {
    const input = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: "red" },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const output = await normalizeReviewPhoto(input, "image/png");
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(2000);
    expect(metadata.height).toBe(1000);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });
  it("rejects MIME spoofing, non-images and oversized input", async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(normalizeReviewPhoto(png, "image/jpeg")).rejects.toThrow(
      "validated",
    );
    await expect(
      normalizeReviewPhoto(
        Buffer.from("<svg onload='alert(1)'/>"),
        "image/png",
      ),
    ).rejects.toThrow("validated");
    await expect(
      normalizeReviewPhoto(
        Buffer.alloc(REVIEW_MAX_PHOTO_BYTES + 1),
        "image/png",
      ),
    ).rejects.toThrow("2 MB");
  });
});
