import {
  loyaltyAppearanceRequestSchema,
  loyaltyAppearanceResponseSchema,
} from "@/lib/weletic/loyalty/appearance-contract";
import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import { describe, expect, it } from "vitest";

const save = {
  operation: "save",
  expectedInstallationGeneration: "generation-1",
  expectedRevision: "a".repeat(64),
  branding: { ...DEFAULT_LOYALTY_BRANDING },
};

describe("signed loyalty appearance contract", () => {
  it("accepts the complete existing branding projection and canonicalizes it", () => {
    const result = loyaltyAppearanceRequestSchema.parse({
      ...save,
      branding: {
        ...save.branding,
        primaryColor: " #ABCDEF ",
        launcherText: " Rewards ",
        heroImageUrl: "",
      },
    });
    expect(result).toMatchObject({
      branding: {
        primaryColor: "#abcdef",
        launcherText: "Rewards",
        heroImageUrl: null,
      },
    });
  });

  it.each(["storeId", "programId", "metadata", "owner"])(
    "rejects client-selected %s",
    (key) => {
      expect(
        loyaltyAppearanceRequestSchema.safeParse({ ...save, [key]: "foreign" })
          .success,
      ).toBe(false);
      expect(
        loyaltyAppearanceRequestSchema.safeParse({
          ...save,
          branding: { ...save.branding, [key]: "foreign" },
        }).success,
      ).toBe(false);
    },
  );

  it.each(["expectedRevision", "expectedInstallationGeneration"])(
    "requires the %s fence",
    (key) => {
      expect(
        loyaltyAppearanceRequestSchema.safeParse({ ...save, [key]: undefined })
          .success,
      ).toBe(false);
      expect(
        loyaltyAppearanceRequestSchema.safeParse({ ...save, [key]: "" })
          .success,
      ).toBe(false);
    },
  );

  it.each([
    "http://example.test/a.png",
    "javascript:alert(1)",
    "https://user:secret@example.test/a.png",
  ])("rejects unsafe hero URLs: %s", (heroImageUrl) => {
    expect(
      loyaltyAppearanceRequestSchema.safeParse({
        ...save,
        branding: { ...save.branding, heroImageUrl },
      }).success,
    ).toBe(false);
  });

  it.each([
    { launcherText: "x".repeat(41) },
    { panelTitle: "" },
    { panelWelcomeSubtitle: "x".repeat(301) },
    { launcherPosition: "top_right" },
    { launcherIcon: "custom" },
    { primaryColor: "red" },
    { headerTextColor: "#fff" },
    { enableFloatingLauncher: "true" },
    { launcherText: "Rewards\nInjected" },
  ])("rejects invalid fields %j", (patch) => {
    expect(
      loyaltyAppearanceRequestSchema.safeParse({
        ...save,
        branding: { ...save.branding, ...patch },
      }).success,
    ).toBe(false);
  });

  it("does not accept partial saves or privileged response fields", () => {
    expect(
      loyaltyAppearanceRequestSchema.safeParse({
        ...save,
        branding: { primaryColor: "#000000" },
      }).success,
    ).toBe(false);
    const response = {
      storeId: "store-1",
      installationGeneration: "generation-1",
      revision: save.expectedRevision,
      programConfigured: true,
      branding: save.branding,
      capabilities: { configure: true },
    };
    expect(loyaltyAppearanceResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      loyaltyAppearanceResponseSchema.safeParse({
        ...response,
        accessToken: "secret",
      }).success,
    ).toBe(false);
    expect(
      loyaltyAppearanceRequestSchema.safeParse({
        operation: "read",
        branding: save.branding,
      }).success,
    ).toBe(false);
  });
});
