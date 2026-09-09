import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  catalog: vi.fn(),
  options: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findFirst: mocks.store },
    integration: { findMany: mocks.catalog },
  },
}));
// The production workspace wrapper remains the authorization boundary. This
// fixture tests that the handler consumes its result, not untrusted query IDs.
vi.mock("@/lib/auth", () => ({
  withWorkspace: (handler: Function, options: unknown) => {
    mocks.options(options);
    return () =>
      handler({
        workspace: { id: "authorized-workspace", slug: "authorized-slug" },
      });
  },
}));

import { readWorkspaceIntegrationInventory } from "@/lib/weletic/shopify/integration-inventory";
import { GET } from "../../app/api/integrations/route";

describe("workspace Shopify configuration inventory", () => {
  beforeEach(() => {
    mocks.store.mockReset();
    mocks.catalog.mockReset();
    vi.stubEnv("SHOPIFY_API_KEY", "current-app");
    mocks.store.mockResolvedValue({ id: "internal-store" });
    mocks.catalog.mockResolvedValue([
      {
        id: SHOPIFY_INTEGRATION_ID,
        projectId: "catalog-owner",
        name: "Shopify",
        slug: "shopify",
        verified: true,
      },
    ]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("discovers native metadata only for the authorized workspace and current app", async () => {
    await readWorkspaceIntegrationInventory("authorized-workspace");
    expect(mocks.store).toHaveBeenCalledWith({
      where: {
        projectId: "authorized-workspace",
        complianceState: { not: "redacted" },
        OR: [
          {
            pendingInstallation: {
              is: { appId: "current-app", state: { not: "redacted" } },
            },
          },
          { installationCredentials: { some: { appId: "current-app" } } },
        ],
      },
      select: { id: true },
    });
    expect(mocks.catalog.mock.calls[0][0].where.OR).toEqual([
      { installations: { some: { projectId: "authorized-workspace" } } },
      { id: SHOPIFY_INTEGRATION_ID },
    ]);
    expect(mocks.catalog.mock.calls[0][0].select).not.toHaveProperty(
      "installations",
    );
    expect(mocks.catalog.mock.calls[0][0].select).not.toHaveProperty(
      "credentials",
    );
  });

  it("retains generic provider discovery without fabricating native installations", async () => {
    mocks.store.mockResolvedValue(null);
    await readWorkspaceIntegrationInventory("authorized-workspace");
    expect(mocks.catalog.mock.calls[0][0].where).toEqual({
      OR: [{ installations: { some: { projectId: "authorized-workspace" } } }],
    });
  });

  it("never issues an unscoped native query if the runtime app ID is absent", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "  ");
    await readWorkspaceIntegrationInventory("authorized-workspace");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.catalog.mock.calls[0][0].where.OR).toHaveLength(1);
  });

  it("propagates database failures instead of reporting an empty or legacy-only inventory", async () => {
    mocks.store.mockRejectedValue(new Error("database unavailable"));
    await expect(
      readWorkspaceIntegrationInventory("authorized-workspace"),
    ).rejects.toThrow("database unavailable");
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("uses wrapper-authorized identity and returns only no-store catalog data", async () => {
    const response = await GET(
      new NextRequest(
        "https://app.invalid/api/integrations?workspaceId=foreign&shop=foreign",
      ),
      { params: Promise.resolve({}) },
    );
    expect(mocks.options).toHaveBeenCalledWith({
      requiredPermissions: ["workspaces.read"],
    });
    expect(mocks.store.mock.calls[0][0].where.projectId).toBe(
      "authorized-workspace",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual([
      {
        id: SHOPIFY_INTEGRATION_ID,
        projectId: "catalog-owner",
        name: "Shopify",
        slug: "shopify",
        verified: true,
      },
    ]);
  });
});
