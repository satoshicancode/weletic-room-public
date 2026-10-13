import { z } from "zod";

export const LAUNCHER_SHAPES = [
  "square",
  "shaved",
  "rounded",
  "circular",
] as const;
export const LAUNCHER_LAYOUTS = [
  "icon_text",
  "text_icon",
  "icon_only",
  "text_only",
] as const;
export const LAUNCHER_VISIBILITY = ["all", "desktop_only", "hidden"] as const;
// Weletic safety bounds, not inferred Smile validation rules.
export const LAUNCHER_MAX_SPACING_PX = 128;
export const LAUNCHER_MOBILE_BREAKPOINT_PX = 767;
const boundedText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const deviceSchema = z
  .object({
    text: boundedText(40).min(1).nullable(),
    position: z.enum(["bottom_left", "bottom_right"]).nullable(),
    layout: z.enum(LAUNCHER_LAYOUTS),
    sideSpacing: z.number().int().min(0).max(LAUNCHER_MAX_SPACING_PX),
    bottomSpacing: z.number().int().min(0).max(LAUNCHER_MAX_SPACING_PX),
  })
  .strict();

export const loyaltyLauncherPresentationSchema = z
  .object({
    desktop: deviceSchema,
    mobile: deviceSchema,
    shape: z.enum(LAUNCHER_SHAPES),
    visibility: z.enum(LAUNCHER_VISIBILITY),
    hideOnHomepage: z.boolean(),
    excludedUrlContains: z
      .array(boundedText(256).min(1))
      .max(20)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type LoyaltyLauncherPresentation = z.infer<
  typeof loyaltyLauncherPresentationSchema
>;

/** Preserve the shipped widget, not the observed Smile store's defaults. */
export function getDefaultLauncherPresentation(): LoyaltyLauncherPresentation {
  const device = {
    text: null,
    position: null,
    layout: "icon_text" as const,
    sideSpacing: 24,
    bottomSpacing: 24,
  };
  return {
    desktop: { ...device },
    mobile: { ...device },
    shape: "circular",
    visibility: "all",
    hideOnHomepage: false,
    excludedUrlContains: [],
  };
}
