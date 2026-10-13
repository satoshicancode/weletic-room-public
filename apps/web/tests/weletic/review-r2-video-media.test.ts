import { finalizeReviewVideo } from "@/lib/weletic/reviews/media";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codec: "avc",
  audioCodec: "aac",
  storage: {
    head: vi.fn(),
    getSignedDownloadUrl: vi.fn(),
  },
  mediaFind: vi.fn(),
  mediaUpdate: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("mediabunny", () => {
  const mp4 = { name: "mp4" };
  return {
    MP4: mp4,
    UrlSource: class UrlSource {},
    Input: class Input {
      canRead = async () => true;
      getFormat = async () => mp4;
      getVideoTracks = async () => [
        {
          getCodec: async () => mocks.codec,
          getDisplayWidth: async () => 1920,
          getDisplayHeight: async () => 1080,
        },
      ];
      getAudioTracks = async () => [{ getCodec: async () => mocks.audioCodec }];
      computeDuration = async () => 30;
      dispose = vi.fn();
    },
  };
});
vi.mock("@/lib/storage", () => ({ storage: mocks.storage }));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: async (
    _storeId: string,
    operation: (tx: Prisma.TransactionClient, generation: string) => unknown,
  ) => operation({} as Prisma.TransactionClient, "g1"),
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: ({ fn }: { fn: () => unknown }) => fn(),
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: ({ fn }: { fn: () => unknown }) => fn(),
}));
vi.mock("@/lib/weletic/reviews/requests", () => ({
  readUsableReviewRequest: async () => ({
    request: {
      id: "request-1",
      shopper: { shopifyCustomerId: "customer-1" },
    },
    settings: { videoUploadsEnabled: true },
  }),
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUniqueOrThrow: async () => ({ projectId: "workspace-1" }),
    },
    weleticReviewMedia: {
      findFirst: mocks.mediaFind,
      updateMany: mocks.mediaUpdate,
    },
    $transaction: async (operation: (tx: object) => unknown) =>
      operation({
        weleticReviewMedia: { updateMany: mocks.mediaUpdate },
      }),
  },
}));

const token = "a".repeat(43);
const media = {
  id: "wrevmedia_video",
  storeId: "store-1",
  requestId: "request-1",
  objectKey: "weletic/reviews/store-1/wrevmedia_video.mp4",
  contentType: "video/mp4",
  sizeBytes: 1024,
};

describe("R2 review video finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STORAGE_ENDPOINT", "https://r2.example.invalid");
    vi.stubEnv("STORAGE_PRIVATE_BUCKET", "private-reviews");
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", "fixture-access-key");
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "fixture-secret-key");
    mocks.codec = "avc";
    mocks.audioCodec = "aac";
    mocks.mediaFind.mockResolvedValue(media);
    mocks.mediaUpdate.mockResolvedValue({ count: 1 });
    mocks.storage.head.mockResolvedValue({
      contentLength: 1024,
      contentType: "video/mp4",
    });
    mocks.storage.getSignedDownloadUrl.mockResolvedValue(
      "https://r2.example.invalid/video",
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("marks only a matching H.264/AAC MP4 as uploaded", async () => {
    await expect(
      finalizeReviewVideo("store-1", { token, mediaId: media.id }),
    ).resolves.toMatchObject({
      id: media.id,
      durationMs: 30_000,
      width: 1920,
      height: 1080,
      videoCodec: "avc",
      audioCodec: "aac",
    });
    expect(mocks.mediaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "uploaded",
          videoCodec: "avc",
        }),
      }),
    );
  });

  it("rejects an unsupported codec and schedules object deletion", async () => {
    mocks.codec = "hevc";
    await expect(
      finalizeReviewVideo("store-1", { token, mediaId: media.id }),
    ).rejects.toThrow("H.264");
    expect(mocks.mediaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "deletion_pending" } }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `review_media_invalid:${media.id}`,
      }),
    );
  });
});
