import {
  getDefaultLauncherPresentation,
  loyaltyLauncherPresentationSchema,
  type LoyaltyLauncherPresentation,
} from "./launcher-presentation";

export const LOYALTY_LAUNCHER_POSITIONS = [
  "bottom_right",
  "bottom_left",
] as const;

export const LOYALTY_LAUNCHER_ICONS = [
  "award",
  "gift",
  "crown",
  "star",
  "sparkles",
] as const;

export type LoyaltyLauncherPosition =
  (typeof LOYALTY_LAUNCHER_POSITIONS)[number];
export type LoyaltyLauncherIcon = (typeof LOYALTY_LAUNCHER_ICONS)[number];

export interface LoyaltyBranding {
  launcherText: string;
  launcherPosition: LoyaltyLauncherPosition;
  launcherIcon: LoyaltyLauncherIcon;
  primaryColor: string;
  headerTextColor: string;
  panelTitle: string;
  panelWelcomeSubtitle: string;
  heroImageUrl: string | null;
  enableFloatingLauncher: boolean;
  launcherPresentation?: LoyaltyLauncherPresentation;
}

export type LoyaltyBrandingInput = Partial<LoyaltyBranding>;

export interface LoyaltyBrandingResponse {
  branding: LoyaltyBranding;
  programId: string | null;
}

export interface LoyaltyBrandingUpdateResponse {
  success: true;
  branding: LoyaltyBranding;
}

export const DEFAULT_LOYALTY_BRANDING: Readonly<LoyaltyBranding> =
  Object.freeze({
    launcherText: "Rewards",
    launcherPosition: "bottom_right",
    launcherIcon: "gift",
    primaryColor: "#059669",
    headerTextColor: "#ffffff",
    panelTitle: "Loyalty Rewards",
    panelWelcomeSubtitle:
      "Earn points, level up, and unlock exclusive discounts.",
    heroImageUrl: null,
    enableFloatingLauncher: true,
  });

const BRANDING_KEYS = [
  "launcherText",
  "launcherPosition",
  "launcherIcon",
  "primaryColor",
  "headerTextColor",
  "panelTitle",
  "panelWelcomeSubtitle",
  "heroImageUrl",
  "enableFloatingLauncher",
  "launcherPresentation",
] as const satisfies readonly (keyof LoyaltyBranding)[];

const BRANDING_KEY_SET = new Set<string>(BRANDING_KEYS);
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class InvalidLoyaltyBrandingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLoyaltyBrandingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText({
  value,
  field,
  maximumLength,
  fallback,
  allowEmpty = false,
}: {
  value: unknown;
  field: string;
  maximumLength: number;
  fallback: string;
  allowEmpty?: boolean;
}) {
  if (typeof value !== "string") {
    throw new InvalidLoyaltyBrandingError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized && !allowEmpty) return fallback;
  if (normalized.length > maximumLength) {
    throw new InvalidLoyaltyBrandingError(
      `${field} must be ${maximumLength} characters or fewer.`,
    );
  }
  return normalized;
}

function readColor(value: unknown, field: string) {
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value.trim())) {
    throw new InvalidLoyaltyBrandingError(
      `${field} must be a six-digit hexadecimal color such as #059669.`,
    );
  }
  return value.trim().toLowerCase();
}

function readHeroImageUrl(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 2048) {
    throw new InvalidLoyaltyBrandingError(
      "heroImageUrl must be an HTTPS URL with 2048 characters or fewer.",
    );
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("unsafe URL");
    }
    return url.toString();
  } catch {
    throw new InvalidLoyaltyBrandingError(
      "heroImageUrl must be a valid HTTPS URL without embedded credentials.",
    );
  }
}

export function getDefaultLoyaltyBranding(
  programName?: string | null,
): LoyaltyBranding {
  const normalizedProgramName = programName?.trim().slice(0, 100);
  return {
    ...DEFAULT_LOYALTY_BRANDING,
    panelTitle: normalizedProgramName || DEFAULT_LOYALTY_BRANDING.panelTitle,
  };
}

export function parseLoyaltyBrandingInput(
  value: unknown,
  options: {
    current?: LoyaltyBranding;
    programName?: string | null;
  } = {},
): LoyaltyBranding {
  if (!isRecord(value)) {
    throw new InvalidLoyaltyBrandingError("branding must be an object.");
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !BRANDING_KEY_SET.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new InvalidLoyaltyBrandingError(
      `Unsupported branding field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
    );
  }

  const branding = {
    ...(options.current || getDefaultLoyaltyBranding(options.programName)),
  };

  if (Object.hasOwn(value, "launcherText")) {
    branding.launcherText = readText({
      value: value.launcherText,
      field: "launcherText",
      maximumLength: 40,
      fallback: branding.launcherText,
    });
  }
  if (Object.hasOwn(value, "launcherPosition")) {
    if (
      typeof value.launcherPosition !== "string" ||
      !LOYALTY_LAUNCHER_POSITIONS.includes(
        value.launcherPosition as LoyaltyLauncherPosition,
      )
    ) {
      throw new InvalidLoyaltyBrandingError(
        `launcherPosition must be one of: ${LOYALTY_LAUNCHER_POSITIONS.join(", ")}.`,
      );
    }
    branding.launcherPosition =
      value.launcherPosition as LoyaltyLauncherPosition;
  }
  if (Object.hasOwn(value, "launcherIcon")) {
    if (
      typeof value.launcherIcon !== "string" ||
      !LOYALTY_LAUNCHER_ICONS.includes(
        value.launcherIcon as LoyaltyLauncherIcon,
      )
    ) {
      throw new InvalidLoyaltyBrandingError(
        `launcherIcon must be one of: ${LOYALTY_LAUNCHER_ICONS.join(", ")}.`,
      );
    }
    branding.launcherIcon = value.launcherIcon as LoyaltyLauncherIcon;
  }
  if (Object.hasOwn(value, "primaryColor")) {
    branding.primaryColor = readColor(value.primaryColor, "primaryColor");
  }
  if (Object.hasOwn(value, "headerTextColor")) {
    branding.headerTextColor = readColor(
      value.headerTextColor,
      "headerTextColor",
    );
  }
  if (Object.hasOwn(value, "panelTitle")) {
    branding.panelTitle = readText({
      value: value.panelTitle,
      field: "panelTitle",
      maximumLength: 100,
      fallback: branding.panelTitle,
    });
  }
  if (Object.hasOwn(value, "panelWelcomeSubtitle")) {
    branding.panelWelcomeSubtitle = readText({
      value: value.panelWelcomeSubtitle,
      field: "panelWelcomeSubtitle",
      maximumLength: 300,
      fallback: branding.panelWelcomeSubtitle,
      allowEmpty: true,
    });
  }
  if (Object.hasOwn(value, "heroImageUrl")) {
    branding.heroImageUrl = readHeroImageUrl(value.heroImageUrl);
  }
  if (Object.hasOwn(value, "enableFloatingLauncher")) {
    if (typeof value.enableFloatingLauncher !== "boolean") {
      throw new InvalidLoyaltyBrandingError(
        "enableFloatingLauncher must be a boolean.",
      );
    }
    branding.enableFloatingLauncher = value.enableFloatingLauncher;
  }

  if (Object.hasOwn(value, "launcherPresentation")) {
    const parsed = loyaltyLauncherPresentationSchema.safeParse(
      value.launcherPresentation,
    );
    if (!parsed.success)
      throw new InvalidLoyaltyBrandingError("Invalid launcher presentation.");
    branding.launcherPresentation = parsed.data;
  }

  return branding;
}

export function normalizeStoredLoyaltyBranding(
  value: unknown,
  programName?: string | null,
): LoyaltyBranding {
  let normalized = getDefaultLoyaltyBranding(programName);
  if (!isRecord(value)) return normalized;

  for (const key of BRANDING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    try {
      normalized = parseLoyaltyBrandingInput(
        { [key]: value[key] },
        { current: normalized },
      );
    } catch (error) {
      if (!(error instanceof InvalidLoyaltyBrandingError)) throw error;
      // A malformed saved visibility policy must not silently reveal a launcher
      // the merchant intended to hide. The editor can repair this safe projection.
      if (key === "launcherPresentation") {
        normalized.launcherPresentation = {
          ...getDefaultLauncherPresentation(),
          visibility: "hidden",
        };
      }
    }
  }
  return normalized;
}
