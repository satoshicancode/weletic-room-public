import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installationBootstrapError } from "../app/installation-bootstrap-error";
import {
  action as homepageAction,
  loader as homepageLoader,
} from "../app/routes/_index";
import {
  action as appearanceAction,
  loader as appearanceLoader,
} from "../app/routes/appearance";
import {
  action as customersAction,
  loader as customersLoader,
} from "../app/routes/customers";
import {
  action as earningAction,
  loader as earningLoader,
} from "../app/routes/earning-rules";
import { loader as installationLoader } from "../app/routes/installation";
import {
  action as loyaltyAction,
  loader as loyaltyLoader,
} from "../app/routes/loyalty";
import {
  action as referralsAction,
  loader as referralsLoader,
} from "../app/routes/loyalty-referrals";
import {
  action as rewardsAction,
  loader as rewardsLoader,
} from "../app/routes/loyalty-rewards";
import {
  action as reviewsAction,
  loader as reviewsLoader,
} from "../app/routes/reviews";
import {
  action as settingsAction,
  loader as settingsLoader,
} from "../app/routes/settings";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), gateway: vi.fn() }));
it("renders safe recovery text for ordinary bootstrap errors without rethrowing or leaking details", () => {
  const markup = renderToStaticMarkup(
    installationBootstrapError(new Error("private-provider-token")),
  );
  expect(markup).toContain("Open installation status to recover");
  expect(markup).not.toContain("private-provider-token");
});
it("keeps the identifier-free status shell reachable when ordinary bootstrap rejects uninstall", async () => {
  vi.clearAllMocks();
  mocks.admin.mockRejectedValue(new Error("stale_session"));
  const response = installationLoader();
  expect(await response.json()).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(mocks.gateway).not.toHaveBeenCalled();
  await expect(
    homepageLoader({
      request: new Request("https://app.invalid/"),
      context: {},
      params: {},
    }),
  ).rejects.toThrow("stale_session");
});
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.admin },
}));
vi.mock("../app/weletic-api.server", () => ({
  weleticApiJson: mocks.gateway,
}));

describe.each([
  { name: "homepage", action: homepageAction, loader: homepageLoader },
  { name: "reviews", action: reviewsAction, loader: reviewsLoader },
  { name: "customers", action: customersAction, loader: customersLoader },
  { name: "settings", action: settingsAction, loader: settingsLoader },
  { name: "appearance", action: appearanceAction, loader: appearanceLoader },
  { name: "loyalty", action: loyaltyAction, loader: loyaltyLoader },
  { name: "earning-rules", action: earningAction, loader: earningLoader },
  { name: "loyalty-rewards", action: rewardsAction, loader: rewardsLoader },
  {
    name: "loyalty-referrals",
    action: referralsAction,
    loader: referralsLoader,
  },
])("embedded $name bootstrap boundary", ({ action, loader }) => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves installation authentication but returns no merchant/session data", async () => {
    mocks.admin.mockResolvedValue({
      session: {
        shop: "private.myshopify.com",
        accessToken: "synthetic-offline-token",
      },
    });
    const request = new Request(
      "https://app.invalid/?shop=private.myshopify.com",
    );
    const response = await loader({ request, params: {}, context: {} });
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith(request);
    expect(await response.json()).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("propagates install/reinstall redirects rather than treating bootstrap as authorization", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    mocks.admin.mockRejectedValue(redirect);
    await expect(
      loader({
        request: new Request("https://app.invalid/"),
        params: {},
        context: {},
      }),
    ).rejects.toBe(redirect);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("rejects form POSTs without authenticating or dispatching a job", async () => {
    const response = action();
    expect(response.status).toBe(405);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
});
