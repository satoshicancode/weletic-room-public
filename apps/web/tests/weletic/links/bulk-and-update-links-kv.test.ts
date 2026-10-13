import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockEvictLinkFromKv,
  mockEvictLinksBatchFromKv,
  mockTombstoneLinkInKv,
  mockLinkCacheSet,
  mockLinkCacheDelete,
  mockLinkCacheMset,
  mockPrismaLinkUpdate,
  waitUntilTasks,
} = vi.hoisted(() => ({
  mockEvictLinkFromKv: vi.fn(async () => true),
  mockEvictLinksBatchFromKv: vi.fn(async () => ({ evictedCount: 2 })),
  mockTombstoneLinkInKv: vi.fn(async () => true),
  mockLinkCacheSet: vi.fn(async () => {}),
  mockLinkCacheDelete: vi.fn(async () => 1),
  mockLinkCacheMset: vi.fn(async () => []),
  mockPrismaLinkUpdate: vi.fn(),
  waitUntilTasks: [] as Promise<any>[],
}));

vi.mock("../../../lib/weletic/link-kv-cache", () => ({
  evictLinkFromKv: mockEvictLinkFromKv,
  evictLinksBatchFromKv: mockEvictLinksBatchFromKv,
  tombstoneLinkInKv: mockTombstoneLinkInKv,
  buildKvKey: (domain: string, key: string) =>
    `link:${domain}:${key.toLowerCase()}`,
}));

vi.mock("../../../lib/api/links/cache", () => ({
  linkCache: {
    set: mockLinkCacheSet,
    delete: mockLinkCacheDelete,
    mset: mockLinkCacheMset,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<any>) => {
    waitUntilTasks.push(promise);
    return promise;
  }),
}));

vi.mock("../../../lib/tinybird", () => ({
  recordLink: vi.fn(async () => {}),
}));
vi.mock("../../../lib/tinybird/record-link", () => ({
  recordLink: vi.fn(async () => {}),
}));

vi.mock("../../../lib/storage", () => ({
  isNotHostedImage: vi.fn(() => false),
  storage: {
    upload: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
}));

vi.mock("../../../lib/planetscale/get-partner-enrollment-info", () => ({
  getPartnerEnrollmentInfo: vi.fn(async () => ({
    partner: null,
    discount: null,
  })),
}));

vi.mock("../../../lib/api/links/ab-test-scheduler", () => ({
  scheduleABTestCompletion: vi.fn(),
}));

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    link: {
      update: (...args: any[]) => mockPrismaLinkUpdate(...args),
    },
  },
}));

import { bulkUpdateLinks } from "../../../lib/api/links/bulk-update-links";
import { updateLink } from "../../../lib/api/links/update-link";

describe("LNK-01 & LNK-06: updateLink and bulkUpdateLinks KV Synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilTasks.length = 0;
  });

  it("updateLink evicts KV cache when an active link is updated", async () => {
    mockPrismaLinkUpdate.mockResolvedValueOnce({
      id: "lnk_100",
      domain: "dub.sh",
      key: "active-slug",
      url: "https://yamax.co/updated-destination",
      disabledAt: null,
      projectId: "ws_test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await updateLink({
      oldLink: {
        domain: "dub.sh",
        key: "active-slug",
      },
      updatedLink: {
        id: "lnk_100",
        domain: "dub.sh",
        key: "active-slug",
        url: "https://yamax.co/updated-destination",
        clicks: 0,
        lastClicked: null,
        updatedAt: new Date(),
      } as any,
    });

    await Promise.all(waitUntilTasks);

    expect(mockLinkCacheSet).toHaveBeenCalledTimes(1);
    expect(mockEvictLinkFromKv).toHaveBeenCalledWith({
      domain: "dub.sh",
      key: "active-slug",
    });
    expect(mockTombstoneLinkInKv).not.toHaveBeenCalled();
  });

  it("updateLink sets tombstone in KV when a link is disabled (disabledAt set)", async () => {
    const disabledAt = new Date().toISOString();
    mockPrismaLinkUpdate.mockResolvedValueOnce({
      id: "lnk_200",
      domain: "dub.sh",
      key: "disabled-slug",
      url: "https://yamax.co/stopped",
      disabledAt,
      projectId: "ws_test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await updateLink({
      oldLink: {
        domain: "dub.sh",
        key: "disabled-slug",
      },
      updatedLink: {
        id: "lnk_200",
        domain: "dub.sh",
        key: "disabled-slug",
        url: "https://yamax.co/stopped",
        clicks: 0,
        lastClicked: null,
        updatedAt: new Date(),
      } as any,
    });

    await Promise.all(waitUntilTasks);

    expect(mockLinkCacheSet).toHaveBeenCalledTimes(1);
    expect(mockTombstoneLinkInKv).toHaveBeenCalledWith({
      domain: "dub.sh",
      key: "disabled-slug",
      disabledAt,
    });
  });

  it("bulkUpdateLinks batch-evicts all modified links from KV", async () => {
    mockPrismaLinkUpdate
      .mockResolvedValueOnce({
        id: "lnk_bulk_1",
        domain: "dub.sh",
        key: "deal-1",
        url: "https://yamax.co/bulk-updated",
        disabledAt: null,
        projectId: "ws_bulk",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "lnk_bulk_2",
        domain: "dub.sh",
        key: "deal-2",
        url: "https://yamax.co/bulk-updated",
        disabledAt: null,
        projectId: "ws_bulk",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    await bulkUpdateLinks({
      workspaceId: "ws_bulk",
      linkIds: ["lnk_bulk_1", "lnk_bulk_2"],
      data: {
        url: "https://yamax.co/bulk-updated",
      } as any,
    });

    await Promise.all(waitUntilTasks);

    expect(mockEvictLinksBatchFromKv).toHaveBeenCalledWith([
      { domain: "dub.sh", key: "deal-1" },
      { domain: "dub.sh", key: "deal-2" },
    ]);
  });
});
