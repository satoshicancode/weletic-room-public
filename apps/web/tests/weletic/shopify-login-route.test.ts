import { beforeEach, describe, expect, it, vi } from "vitest";

const login = vi.fn();

vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  login,
}));

describe("Shopify dedicated login route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates GET login requests to Shopify's login handler", async () => {
    login.mockResolvedValue({});
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/auth.login"
    );
    const request = new Request(
      "https://shopify.weletic.com/auth/login?shop=n0pvef-cs.myshopify.com",
    );

    const response = await loader({ request } as never);

    expect(login).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({});
  });

  it("delegates submitted shop domains to the same Shopify login handler", async () => {
    login.mockResolvedValue({ shop: "INVALID_SHOP" });
    const { action } = await import(
      "../../../../packages/shopify-app/app/routes/auth.login"
    );
    const request = new Request("https://shopify.weletic.com/auth/login", {
      method: "POST",
      body: new URLSearchParams({ shop: "invalid" }),
    });

    const response = await action({ request } as never);

    expect(login).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({ shop: "INVALID_SHOP" });
  });
});
