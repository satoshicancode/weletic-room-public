import {
  getDefaultLauncherPresentation,
  loyaltyLauncherPresentationSchema,
} from "@/lib/weletic/loyalty/launcher-presentation";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const runtime: Record<string, any> = {};
new Function(
  "window",
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../packages/shopify-app/extensions/weletic-analytics/assets/weletic-loyalty-shared.js",
    ),
    "utf8",
  ),
)(runtime);
const context = {
  defaultText: "Rewards",
  defaultPosition: "bottom_right",
  width: 375,
  pathname: "/ja/products/example",
  rootPath: "/ja/",
  url: "https://example.test/ja/products/example?campaign=VIP#rewards",
};
const resolve = (policy: unknown, overrides = {}) =>
  runtime.WeleticLoyaltyShared.resolveLauncherPresentation(
    { launcherPresentation: policy },
    { ...context, ...overrides },
  );
describe("launcher shared runtime policy", () => {
  it.each(["/", "/ja", "/ja/"])(
    "hides homepage %s without hiding products",
    (pathname) => {
      const policy = {
        ...getDefaultLauncherPresentation(),
        hideOnHomepage: true,
      };
      expect(resolve(policy, { pathname }).visible).toBe(false);
      expect(resolve(policy).visible).toBe(true);
    },
  );
  it.each([
    ["campaign=VIP", false],
    ["campaign=vip", true],
    ["#rewards", false],
    ["/products/", false],
    ["/cart", true],
  ])("matches literal case-sensitive URL substring %s", (part, visible) => {
    expect(
      resolve({
        ...getDefaultLauncherPresentation(),
        excludedUrlContains: [part],
      }).visible,
    ).toBe(visible);
  });
  it.each([767, 768])(
    "uses the explicit mobile boundary at width %s",
    (width) => {
      expect(
        resolve(
          { ...getDefaultLauncherPresentation(), visibility: "desktop_only" },
          { width },
        ).visible,
      ).toBe(width > 767);
    },
  );
  it.each([
    { extra: true },
    { excludedUrlContains: ["/cart", " /cart "] },
    { mobile: { ...getDefaultLauncherPresentation().mobile, extra: true } },
    {
      mobile: { ...getDefaultLauncherPresentation().mobile, sideSpacing: 129 },
    },
    { excludedUrlContains: ["a\nb"] },
    { visibility: "unknown" },
  ])("fails closed for server-invalid policy %j", (patch) => {
    const policy = { ...getDefaultLauncherPresentation(), ...patch };
    expect(loyaltyLauncherPresentationSchema.safeParse(policy).success).toBe(
      false,
    );
    expect(resolve(policy).visible).toBe(false);
  });
  it("canonicalizes text consistently with the server", () => {
    const policy = getDefaultLauncherPresentation();
    policy.mobile.text = "  Rewards  ";
    expect(resolve(policy).text).toBe(
      loyaltyLauncherPresentationSchema.parse(policy).mobile.text,
    );
  });
});
