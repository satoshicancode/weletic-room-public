import { SHOPIFY_INTEGRATION_ID } from "@dub/utils/src";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntegrationPage from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/settings/integrations/[integrationSlug]/page";

const mocks = vi.hoisted(() => ({
  integration: vi.fn(),
  installation: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integration: { findUnique: mocks.integration },
    installedIntegration: { findFirst: mocks.installation },
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock(
  "../../app/app.dub.co/(dashboard)/[slug]/(ee)/settings/integrations/[integrationSlug]/page-client",
  () => ({
    default: () => null,
  }),
);

describe("Shopify integration page data boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.integration.mockResolvedValue({
      id: SHOPIFY_INTEGRATION_ID,
      slug: "shopify",
      screenshots: [],
    });
    mocks.installation.mockResolvedValue({
      id: "legacy-row",
      userId: "private-user",
      createdAt: new Date(),
      user: { name: "Private installer", email: "private@example.test" },
      webhooks: [],
      settings: {},
    });
  });
  const page = () =>
    IntegrationPage({
      params: Promise.resolve({
        slug: "authorized-workspace",
        integrationSlug: "shopify",
      }),
    });

  it("does not query or serialize generic installer details for Shopify", async () => {
    const result = await page();
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(result.props.integration.installed).toBeNull();
    expect(JSON.stringify(result.props)).not.toContain("private");
    expect(result.props.integration.credentials).toEqual({});
  });

  it("preserves workspace-scoped installer attribution for other providers", async () => {
    mocks.integration.mockResolvedValue({
      id: "other-provider",
      screenshots: [],
    });
    const result = await page();
    expect(mocks.installation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          integration: { slug: "shopify" },
          project: { slug: "authorized-workspace" },
        },
      }),
    );
    expect(result.props.integration.installed?.by.id).toBe("private-user");
  });

  it("redirects missing integrations before reading installer data", async () => {
    mocks.integration.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:");
    expect(mocks.installation).not.toHaveBeenCalled();
  });

  it("keeps Shopify management reachable despite a legacy catalog guide URL", async () => {
    mocks.integration.mockResolvedValue({
      id: SHOPIFY_INTEGRATION_ID,
      screenshots: [],
      guideUrl: "https://example.test/legacy-guide",
    });
    expect((await page()).props.integration.installed).toBeNull();
    expect(mocks.installation).not.toHaveBeenCalled();
  });
});
