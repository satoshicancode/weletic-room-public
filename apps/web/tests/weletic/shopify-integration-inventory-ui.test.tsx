import { IntegrationInventoryList } from "@/ui/integrations/integration-inventory-list";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EnabledIntegrationsPage from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/settings/integrations/enabled/page";
const mocks = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("@/lib/swr/use-workspace", () => ({
  default: () => ({ slug: "company-one" }),
}));
vi.mock("@/lib/swr/use-integrations", () => ({ default: mocks.inventory }));
vi.mock("@/ui/integrations/integration-logo", () => ({
  IntegrationLogo: () => null,
}));
vi.mock("@/ui/integrations/integration-status-badge", () => ({
  IntegrationStatusBadge: () => null,
}));

const shopify = {
  id: SHOPIFY_INTEGRATION_ID,
  projectId: "catalog-owner",
  name: "Shopify",
  slug: "shopify",
  verified: true,
};
const render = () => renderToStaticMarkup(<EnabledIntegrationsPage />);
describe("configured integration inventory presentation", () => {
  beforeEach(() => {
    mocks.inventory.mockReturnValue({
      integrations: [shopify],
      loading: false,
    });
  });
  it("presents Shopify management without enabled or installer claims", () => {
    const html = render();
    expect(html).toContain("Configured integrations");
    expect(html).toContain("Managed in Shopify");
    expect(html).toContain("approval and connection status checked separately");
    expect(html).toContain('href="/company-one/settings/integrations/shopify"');
    expect(html).not.toContain("Enabled");
    expect(html).not.toContain("Installed");
  });
  it("preserves enabled labels and links for generic providers", () => {
    const html = renderToStaticMarkup(
      <IntegrationInventoryList
        workspaceSlug="company-one"
        integrations={[
          { ...shopify, id: "generic", name: "Other provider", slug: "other" },
        ]}
      />,
    );
    expect(html).toContain("Enabled");
    expect(html).toContain('href="/company-one/settings/integrations/other"');
    expect(html).not.toContain("Managed in Shopify");
  });
  it("reports loading rather than an empty installation state", () => {
    mocks.inventory.mockReturnValue({ loading: true });
    expect(render()).toContain('role="status"');
    expect(render()).toContain("Loading configured integrations");
    expect(render()).not.toContain("No integrations");
  });
  it("hides stale inventory on refresh or permission errors", () => {
    mocks.inventory.mockReturnValue({
      integrations: [shopify],
      error: new Error("private database detail"),
    });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Managed in Shopify");
    expect(html).not.toContain("private database detail");
  });
  it("reports an empty authorized workspace without implying an auth failure", () => {
    mocks.inventory.mockReturnValue({ integrations: [], loading: false });
    expect(render()).toContain("No integrations configured for this workspace");
  });
});
