import {
  merchantLogoUrlSchema,
  MerchantSettingsError,
  merchantSettingsUpdateSchema,
  merchantTimeZoneSchema,
} from "@/lib/weletic/merchant-settings/contracts";
import { merchantSettingsHttpError } from "@/lib/weletic/merchant-settings/http";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

describe("shared merchant settings contract", () => {
  const base = { expectedRevision: 0, expectedInstallationGeneration: "g1" };
  it("normalizes explicit branding without inferring timezone or module activation", () => {
    expect(
      merchantSettingsUpdateSchema.parse({
        ...base,
        settings: { brandName: "  Hiro Store  ", accentColor: "#AbCdEf" },
      }),
    ).toEqual({
      ...base,
      settings: { brandName: "Hiro Store", accentColor: "#abcdef" },
    });
  });
  it.each([
    {},
    { settings: {} },
    { settings: { enabled: true } },
    { expectedRevision: -1, settings: { brandName: "Shop" } },
    { expectedRevision: 1.5, settings: { brandName: "Shop" } },
    { expectedInstallationGeneration: "", settings: { brandName: "Shop" } },
    { storeId: "foreign", settings: { brandName: "Shop" } },
    { settings: { shopperEmailPaused: "false" } },
    { settings: { defaultLocale: "unsupported" } },
    { settings: { brandName: "" } },
    { settings: { brandName: "line\nbreak" } },
  ])("rejects malformed or out-of-scope input %j", (input) => {
    expect(
      merchantSettingsUpdateSchema.safeParse({ ...base, ...input }).success,
    ).toBe(false);
  });
  it.each(["America/New_York", "Asia/Tokyo", "Asia/Ho_Chi_Minh", "UTC"])(
    "accepts explicit IANA zone %s",
    (zone) => {
      expect(merchantTimeZoneSchema.parse(zone)).toBe(zone);
    },
  );
  it.each(["Tokyo", "GMT+9", "Not/AZone", "+09:00"])(
    "rejects ambiguous/invalid zone %s",
    (zone) => {
      expect(merchantTimeZoneSchema.safeParse(zone).success).toBe(false);
    },
  );
  it.each([
    "not a URL",
    "http://cdn.shopify.com/logo.png",
    "https://user:pass@cdn.shopify.com/logo.png",
    "https://127.0.0.1/logo",
    "https://service.internal/logo",
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "https://cdn.shopify.com:123/logo",
  ])("rejects nonpublic logo URL %s", (url) => {
    expect(merchantLogoUrlSchema.safeParse(url).success).toBe(false);
  });
  it("accepts CDN logos and supports explicit clearing", () => {
    expect(
      merchantLogoUrlSchema.parse("https://cdn.shopify.com/s/files/logo.png"),
    ).toContain("cdn.shopify.com");
    expect(
      merchantSettingsUpdateSchema.parse({
        ...base,
        settings: {
          brandName: null,
          logoUrl: null,
          accentColor: null,
          timeZone: null,
        },
      }).settings.timeZone,
    ).toBeNull();
  });
  it.each([
    ["not_found", 404],
    ["conflict", 409],
    ["forbidden", 403],
  ] as const)("returns private %s errors", async (code, status) => {
    const response = merchantSettingsHttpError(new MerchantSettingsError(code));
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: { code } });
  });
  it("never exposes provider/configuration errors", async () => {
    const response = merchantSettingsHttpError(
      new Error("secret-private-address"),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-private-address");
  });
});
