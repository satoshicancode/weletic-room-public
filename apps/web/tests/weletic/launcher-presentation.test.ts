import { describe, expect, it } from "vitest";
import { loyaltyAppearanceBrandingSchema } from "../../lib/weletic/loyalty/appearance-contract";
import {
  getDefaultLoyaltyBranding,
  normalizeStoredLoyaltyBranding,
  parseLoyaltyBrandingInput,
} from "../../lib/weletic/loyalty/branding";
import {
  getDefaultLauncherPresentation,
  loyaltyLauncherPresentationSchema,
} from "../../lib/weletic/loyalty/launcher-presentation";

describe("launcher presentation contract", () => {
  it("preserves the existing nine-field defaults until configured", () => {
    const branding = getDefaultLoyaltyBranding();
    expect(branding).not.toHaveProperty("launcherPresentation");
    expect(loyaltyAppearanceBrandingSchema.parse(branding)).toEqual(branding);
    expect(getDefaultLauncherPresentation()).toMatchObject({
      desktop: { sideSpacing: 24, bottomSpacing: 24, layout: "icon_text" },
      mobile: { sideSpacing: 24, bottomSpacing: 24, layout: "icon_text" },
      shape: "circular",
      visibility: "all",
      excludedUrlContains: [],
    });
  });
  it("returns independent default objects", () => {
    const value = getDefaultLauncherPresentation();
    value.desktop.sideSpacing = 0;
    value.excludedUrlContains.push("/excluded");
    expect(value.mobile.sideSpacing).toBe(24);
    expect(getDefaultLauncherPresentation().excludedUrlContains).toEqual([]);
  });
  it("roundtrips device overrides through existing branding and appearance schemas", () => {
    const presentation = getDefaultLauncherPresentation();
    presentation.mobile.text = " Đổi thưởng ";
    presentation.mobile.layout = "text_only";
    presentation.mobile.position = "bottom_left";
    presentation.mobile.sideSpacing = 16;
    presentation.desktop.bottomSpacing = 20;
    presentation.visibility = "desktop_only";
    presentation.hideOnHomepage = true;
    presentation.excludedUrlContains = ["/checkout", "/products/private"];
    const branding = parseLoyaltyBrandingInput({
      launcherPresentation: presentation,
    });
    expect(branding.launcherPresentation?.mobile.text).toBe("Đổi thưởng");
    expect(loyaltyAppearanceBrandingSchema.parse(branding)).toEqual(branding);
    expect(normalizeStoredLoyaltyBranding(branding)).toEqual(branding);
  });
  it.each([-1, 129, 1.5, NaN, Infinity, "20", null])(
    "rejects invalid spacing %s",
    (value) => {
      const input = getDefaultLauncherPresentation();
      expect(
        loyaltyLauncherPresentationSchema.safeParse({
          ...input,
          mobile: { ...input.mobile, sideSpacing: value },
        }).success,
      ).toBe(false);
    },
  );
  it.each(["square", "shaved", "rounded", "circular"])(
    "accepts the supported shape %s",
    (shape) => {
      expect(
        loyaltyLauncherPresentationSchema.safeParse({
          ...getDefaultLauncherPresentation(),
          shape,
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    { shape: "url(javascript:alert(1))" },
    { visibility: "all!important" },
    { ownerId: "foreign" },
    { excludedUrlContains: [""] },
    { excludedUrlContains: [" "] },
    { excludedUrlContains: ["a", " a "] },
    { excludedUrlContains: ["a\nb"] },
    { excludedUrlContains: ["x".repeat(257)] },
    { excludedUrlContains: Array.from({ length: 21 }, (_, i) => String(i)) },
  ])("rejects unsupported or unbounded settings %j", (patch) => {
    expect(
      loyaltyLauncherPresentationSchema.safeParse({
        ...getDefaultLauncherPresentation(),
        ...patch,
      }).success,
    ).toBe(false);
  });
  it("rejects extra device properties and blank override labels", () => {
    const base = getDefaultLauncherPresentation();
    for (const patch of [
      { html: "<script>" },
      { text: " " },
      { text: "x".repeat(41) },
    ]) {
      expect(
        loyaltyLauncherPresentationSchema.safeParse({
          ...base,
          desktop: { ...base.desktop, ...patch },
        }).success,
      ).toBe(false);
    }
  });
  it("preserves configured controls when a legacy partial branding update omits them", () => {
    const current = parseLoyaltyBrandingInput({
      launcherPresentation: getDefaultLauncherPresentation(),
    });
    expect(
      parseLoyaltyBrandingInput({ launcherText: "Points" }, { current })
        .launcherPresentation,
    ).toEqual(current.launcherPresentation);
  });
  it("rejects malformed writes and hides malformed stored presentation without losing other branding", () => {
    expect(() =>
      parseLoyaltyBrandingInput({ launcherPresentation: {} }),
    ).toThrow("Invalid launcher presentation");
    const normalized = normalizeStoredLoyaltyBranding({
      launcherText: "My rewards",
      launcherPresentation: {},
    });
    expect(normalized.launcherText).toBe("My rewards");
    expect(normalized.launcherPresentation?.visibility).toBe("hidden");
    expect(loyaltyAppearanceBrandingSchema.parse(normalized)).toEqual(
      normalized,
    );
  });
});
