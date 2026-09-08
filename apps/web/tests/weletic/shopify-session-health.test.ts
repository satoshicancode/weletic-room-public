import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ store: vi.fn(), issue: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) =>
      callback({
        weleticShopifyStore: { findUnique: mocks.store },
        weleticReconciliationIssue: { findUnique: mocks.issue },
      }),
  },
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (callback: (context: { workspace: { id: string } }) => unknown) =>
    (_request: Request) =>
      callback({ workspace: { id: "authorized-workspace" } }),
}));

import { readShopifySessionHealth } from "@/lib/weletic/shopify/session-health";
import { GET } from "../../app/(ee)/api/weletic/shopify/session-health/route";

describe("merchant Shopify connection incident projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue({
      id: "store-1",
      installationGeneration: "current-generation",
      complianceState: "active",
    });
    mocks.issue.mockResolvedValue({
      status: "open",
      detectedAt: new Date("2026-09-06T00:00:00Z"),
    });
  });

  it("uses the authorized workspace, ignores supplied store IDs and returns no private details", async () => {
    const response = await GET(
      new NextRequest(
        "https://app.invalid/api/weletic/shopify/session-health?storeId=foreign-store&workspaceId=foreign-workspace",
      ),
      { params: Promise.resolve({}) },
    );
    expect(mocks.store).toHaveBeenCalledWith({
      where: { projectId: "authorized-workspace" },
      select: { id: true, installationGeneration: true, complianceState: true },
    });
    expect(mocks.issue).toHaveBeenCalledWith({
      where: {
        storeId_kind_externalKey: {
          storeId: "store-1",
          kind: "shopify_session_missing",
          externalKey: "current-generation",
        },
      },
      select: { status: true, detectedAt: true },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      status: "reconnect_required",
      detectedAt: "2026-09-06T00:00:00.000Z",
    });
  });

  it.each(["absent", "frozen", "redacted", "unbound"])(
    "does not read incidents for an %s installation",
    async (state) => {
      mocks.store.mockResolvedValue(
        state === "absent"
          ? null
          : {
              id: "store-1",
              installationGeneration: state === "unbound" ? null : "g1",
              complianceState: state === "unbound" ? "active" : state,
            },
      );
      expect(await readShopifySessionHealth("authorized-workspace")).toEqual({
        status: "not_connected",
        detectedAt: null,
      });
      expect(mocks.issue).not.toHaveBeenCalled();
    },
  );

  it.each([null, "resolved", "ignored"])(
    "does not claim live health when the incident is %s",
    async (status) => {
      mocks.issue.mockResolvedValue(
        status ? { status, detectedAt: new Date() } : null,
      );
      expect(await readShopifySessionHealth("authorized-workspace")).toEqual({
        status: "not_observed",
        detectedAt: null,
      });
    },
  );
});
