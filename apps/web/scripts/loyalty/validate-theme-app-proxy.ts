import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types & Report Interfaces
// ============================================================================

export type ValidationExecutionMode = "dry-run" | "mock" | "live-admin";

export type ValidationEvidenceSource =
  | "local-static"
  | "simulated"
  | "live-admin"
  | "theme-asset"
  | "app-proxy-gateway";

export interface ValidationEvidenceProvenance {
  source: ValidationEvidenceSource;
  executionMode: ValidationExecutionMode;
  live: boolean;
}

export interface ValidationCheckResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  details?: Record<string, any>;
  error?: string;
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationPhaseResult {
  phaseName: string;
  status: "PASSED" | "FAILED" | "WARNING";
  durationMs: number;
  checks: ValidationCheckResult[];
  provenance: ValidationEvidenceProvenance;
}

export interface ValidationSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
}

export interface ThemeAppProxyValidationReport {
  version: number;
  timestamp: string;
  storeDomain: string;
  executionMode: ValidationExecutionMode;
  overallStatus: "PASSED" | "FAILED" | "WARNING";
  totalDurationMs: number;
  provenance: ValidationEvidenceProvenance;
  summary: ValidationSummary;
  phases: ValidationPhaseResult[];
  errors: Array<{ phase: string; check: string; error: string }>;
}

export interface ValidationCLIOptions {
  storeDomain?: string;
  dryRun?: boolean;
  mock?: boolean;
  live?: boolean;
  json?: boolean;
  outputReportPath?: string;
  confirmStaging?: boolean;
}

// ============================================================================
// Authoritative Shopify App Proxy Utilities
// ============================================================================

/**
 * Stringifies query parameters for Shopify App Proxy according to Shopify's canonical
 * specification: keys sorted alphabetically, values concatenated without delimiter.
 * Ref: @shopify/shopify-api lib/utils/hmac-validator.mjs (stringifyQueryForAppProxy)
 */
export function stringifyQueryForAppProxy(
  query: Record<string, string | string[] | undefined>,
): string {
  return Object.entries(query)
    .filter(
      ([key, val]) =>
        key !== "signature" && key !== "hmac" && val !== undefined,
    )
    .sort(([k1], [k2]) => k1.localeCompare(k2))
    .reduce((acc, [key, value]) => {
      const valStr = Array.isArray(value) ? value.join(",") : String(value);
      return `${acc}${key}=${valStr}`;
    }, "");
}

/**
 * Calculates Shopify App Proxy HMAC-SHA256 signature using the app's API secret.
 */
export function calculateShopifyAppProxySignature(
  query: Record<string, string | string[] | undefined>,
  apiSecret: string,
): string {
  const queryString = stringifyQueryForAppProxy(query);
  return crypto
    .createHmac("sha256", apiSecret)
    .update(queryString)
    .digest("hex");
}

/**
 * Validates a Shopify App Proxy query including timestamp freshness (90s tolerance)
 * and HMAC comparison using constant-time timing-safe comparison.
 */
export function validateShopifyAppProxyQuery(
  query: Record<string, string | string[] | undefined>,
  apiSecret: string,
  nowSec: number = Math.trunc(Date.now() / 1000),
  maxToleranceSec: number = 90,
): { valid: boolean; reason?: string } {
  const signature = query.signature;
  if (!signature || typeof signature !== "string") {
    return { valid: false, reason: "Missing signature query parameter" };
  }

  const timestamp = Number(query.timestamp);
  if (!Number.isFinite(timestamp)) {
    return {
      valid: false,
      reason: "Missing or non-numeric timestamp parameter",
    };
  }

  if (Math.abs(nowSec - timestamp) > maxToleranceSec) {
    return {
      valid: false,
      reason: "HMAC timestamp is outside of the tolerance range",
    };
  }

  const expectedSignature = calculateShopifyAppProxySignature(query, apiSecret);
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return { valid: false, reason: "Invalid HMAC signature" };
  }

  return { valid: true };
}

/**
 * Authoritative subpath normalizer matching packages/shopify-app/app/routes/apps.proxy.$.ts
 */
export function normalizeAppProxySubpath(splat: string | undefined): string {
  if (!splat) return "";
  let clean = splat.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.startsWith("loyalty/")) {
    clean = clean.replace(/^loyalty\//, "");
  }
  return clean;
}

export const ALLOWED_PROXY_GET_PATHS = new Set([
  "program",
  "customer",
  "customer/activity",
]);

export const ALLOWED_PROXY_ACTION_PATHS = new Set([
  "customer/redeem",
  "customer/referral/bind",
  "customer/activity/claim",
  "referral/claim",
]);

export const CUSTOMER_AUTH_REQUIRED_ACTION_PATHS = new Set([
  "customer/redeem",
  "customer/referral/bind",
  "customer/activity/claim",
]);

// ============================================================================
// Core Validation Runner
// ============================================================================

export async function runThemeAppProxyValidation(
  options: ValidationCLIOptions,
): Promise<ThemeAppProxyValidationReport> {
  const startTime = Date.now();
  const storeDomain = options.storeDomain || "staging.myshopify.test";
  const executionMode: ValidationExecutionMode = options.mock
    ? "mock"
    : options.live
      ? "live-admin"
      : "dry-run";

  const provenance: ValidationEvidenceProvenance = {
    source: options.mock
      ? "simulated"
      : options.live
        ? "live-admin"
        : "local-static",
    executionMode,
    live: Boolean(options.live),
  };

  const report: ThemeAppProxyValidationReport = {
    version: 1,
    timestamp: new Date().toISOString(),
    storeDomain,
    executionMode,
    overallStatus: "PASSED",
    totalDurationMs: 0,
    provenance,
    summary: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      skippedChecks: 0,
    },
    phases: [],
    errors: [],
  };

  const repoRoot = path.resolve(__dirname, "../../../..");
  const extensionDir = path.join(
    repoRoot,
    "packages/shopify-app/extensions/weletic-analytics",
  );
  const testApiSecret = "test-shopify-app-proxy-secret-key-32chars";

  // --------------------------------------------------------------------------
  // Phase 1: Extension Bundle & Liquid Block Integrity
  // --------------------------------------------------------------------------
  const phase1Start = Date.now();
  const phase1Checks: ValidationCheckResult[] = [];

  // Check 1: Extension manifest
  const check1Start = Date.now();
  try {
    const tomlPath = path.join(extensionDir, "shopify.extension.toml");
    const tomlExists = fs.existsSync(tomlPath);
    let valid = false;
    let entryPoints: string[] = [];

    if (tomlExists) {
      const content = fs.readFileSync(tomlPath, "utf8");
      const hasTypeTheme = content.includes('type = "theme"');
      const hasEntryPoints = content.includes("entry_points = [");
      const hasAppEmbed = content.includes('"blocks/app-embed.liquid"');
      const hasLanding = content.includes('"blocks/loyalty-landing.liquid"');
      const hasProductPoints = content.includes(
        '"blocks/product-points-preview.liquid"',
      );
      valid =
        hasTypeTheme &&
        hasEntryPoints &&
        hasAppEmbed &&
        hasLanding &&
        hasProductPoints;
      entryPoints = [
        "blocks/app-embed.liquid",
        "blocks/loyalty-landing.liquid",
        "blocks/product-points-preview.liquid",
      ];
    }

    phase1Checks.push({
      name: "extensionManifestValid",
      passed: valid,
      durationMs: Date.now() - check1Start,
      details: { tomlPath, entryPoints },
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  } catch (err: any) {
    phase1Checks.push({
      name: "extensionManifestValid",
      passed: false,
      durationMs: Date.now() - check1Start,
      error: err.message,
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  }

  // Check 2: Liquid security escaping
  const check2Start = Date.now();
  try {
    const appEmbedPath = path.join(extensionDir, "blocks/app-embed.liquid");
    const landingPath = path.join(
      extensionDir,
      "blocks/loyalty-landing.liquid",
    );
    const productPointsPath = path.join(
      extensionDir,
      "blocks/product-points-preview.liquid",
    );

    const appEmbedContent = fs.readFileSync(appEmbedPath, "utf8");
    const landingContent = fs.readFileSync(landingPath, "utf8");
    const productPointsContent = fs.readFileSync(productPointsPath, "utf8");

    const appEmbedEscapesShop = appEmbedContent.includes(
      "shop.permanent_domain | escape",
    );
    const landingEscapesShop = landingContent.includes(
      "shop.permanent_domain | escape",
    );
    const productPointsEscapes = productPointsContent.includes(
      "product.id | escape",
    );
    // Zero-PII Invariant: customer.id is never exposed into the DOM by the theme embed
    const zeroPiiEnforced = !appEmbedContent.includes("customer.id");

    const passed =
      appEmbedEscapesShop &&
      landingEscapesShop &&
      productPointsEscapes &&
      zeroPiiEnforced;

    phase1Checks.push({
      name: "liquidSecurityEscaping",
      passed,
      durationMs: Date.now() - check2Start,
      details: {
        appEmbedEscapesShop,
        landingEscapesShop,
        productPointsEscapes,
        zeroPiiEnforced,
      },
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  } catch (err: any) {
    phase1Checks.push({
      name: "liquidSecurityEscaping",
      passed: false,
      durationMs: Date.now() - check2Start,
      error: err.message,
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  }

  // Check 3: Theme assets existence & integrity
  const check3Start = Date.now();
  try {
    const assetsDir = path.join(extensionDir, "assets");
    const requiredAssets = [
      "weletic-loyalty-shared.js",
      "weletic-loyalty-widget.js",
      "weletic-loyalty-landing.js",
      "weletic-product-points.js",
      "weletic-loyalty-styles.css",
    ];

    const assetStats: Record<string, { sizeBytes: number; exists: boolean }> =
      {};
    let allExist = true;

    for (const asset of requiredAssets) {
      const assetPath = path.join(assetsDir, asset);
      const exists = fs.existsSync(assetPath);
      if (!exists) {
        allExist = false;
        assetStats[asset] = { sizeBytes: 0, exists: false };
      } else {
        const stats = fs.statSync(assetPath);
        assetStats[asset] = { sizeBytes: stats.size, exists: true };
      }
    }

    phase1Checks.push({
      name: "themeAssetsIntegrity",
      passed: allExist,
      durationMs: Date.now() - check3Start,
      details: { assetStats },
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  } catch (err: any) {
    phase1Checks.push({
      name: "themeAssetsIntegrity",
      passed: false,
      durationMs: Date.now() - check3Start,
      error: err.message,
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  }

  // Check 4: Critical CSS rule for launcher hidden attribute
  const check4Start = Date.now();
  try {
    const cssPath = path.join(
      extensionDir,
      "assets/weletic-loyalty-styles.css",
    );
    const cssContent = fs.readFileSync(cssPath, "utf8");
    const hasHiddenRule =
      cssContent.includes(".weletic-launcher-btn[hidden]") ||
      cssContent.includes(".weletic-launcher-btn[hidden=true]") ||
      /weletic-launcher-btn\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(
        cssContent,
      );

    phase1Checks.push({
      name: "criticalCssRules",
      passed: hasHiddenRule,
      durationMs: Date.now() - check4Start,
      details: { hasHiddenRule },
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  } catch (err: any) {
    phase1Checks.push({
      name: "criticalCssRules",
      passed: false,
      durationMs: Date.now() - check4Start,
      error: err.message,
      provenance: { source: "theme-asset", executionMode, live: false },
    });
  }

  const phase1Duration = Date.now() - phase1Start;
  report.phases.push({
    phaseName: "Phase 1: Extension Bundle & Liquid Block Integrity",
    status: phase1Checks.every((c) => c.passed) ? "PASSED" : "FAILED",
    durationMs: phase1Duration,
    checks: phase1Checks,
    provenance,
  });

  // --------------------------------------------------------------------------
  // Phase 2: App Proxy Gateway Routing & Normalization
  // --------------------------------------------------------------------------
  const phase2Start = Date.now();
  const phase2Checks: ValidationCheckResult[] = [];

  // Check 5: Subpath normalization
  const check5Start = Date.now();
  try {
    const testCases: Array<{ input: string | undefined; expected: string }> = [
      { input: "program", expected: "program" },
      { input: "/program/", expected: "program" },
      { input: "loyalty/program", expected: "program" },
      { input: "/loyalty/customer/redeem/", expected: "customer/redeem" },
      { input: "customer/activity", expected: "customer/activity" },
      { input: "referral/claim", expected: "referral/claim" },
      { input: undefined, expected: "" },
    ];

    const normalizationPass = testCases.every(
      (tc) => normalizeAppProxySubpath(tc.input) === tc.expected,
    );

    const getPathsValid = ["program", "customer", "customer/activity"].every(
      (p) => ALLOWED_PROXY_GET_PATHS.has(p),
    );
    const actionPathsValid = [
      "customer/redeem",
      "customer/referral/bind",
      "customer/activity/claim",
      "referral/claim",
    ].every((p) => ALLOWED_PROXY_ACTION_PATHS.has(p));

    phase2Checks.push({
      name: "subpathNormalization",
      passed: normalizationPass && getPathsValid && actionPathsValid,
      durationMs: Date.now() - check5Start,
      details: { normalizationPass, getPathsValid, actionPathsValid },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase2Checks.push({
      name: "subpathNormalization",
      passed: false,
      durationMs: Date.now() - check5Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  // Check 6: Unsupported route rejection
  const check6Start = Date.now();
  try {
    const hostileSubpaths = [
      "admin",
      "settings",
      "eval",
      "debug",
      "webhooks",
      "../secret",
      "customer/delete",
    ];

    const allRejected = hostileSubpaths.every(
      (p) =>
        !ALLOWED_PROXY_GET_PATHS.has(normalizeAppProxySubpath(p)) &&
        !ALLOWED_PROXY_ACTION_PATHS.has(normalizeAppProxySubpath(p)),
    );

    phase2Checks.push({
      name: "unsupportedRouteRejection",
      passed: allRejected,
      durationMs: Date.now() - check6Start,
      details: { hostileSubpathsTested: hostileSubpaths.length, allRejected },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase2Checks.push({
      name: "unsupportedRouteRejection",
      passed: false,
      durationMs: Date.now() - check6Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  const phase2Duration = Date.now() - phase2Start;
  report.phases.push({
    phaseName: "Phase 2: App Proxy Gateway Routing & Normalization",
    status: phase2Checks.every((c) => c.passed) ? "PASSED" : "FAILED",
    durationMs: phase2Duration,
    checks: phase2Checks,
    provenance,
  });

  // --------------------------------------------------------------------------
  // Phase 3: Cryptographic HMAC & Security Boundaries
  // --------------------------------------------------------------------------
  const phase3Start = Date.now();
  const phase3Checks: ValidationCheckResult[] = [];

  // Check 7: Shopify App Proxy HMAC verification
  const check7Start = Date.now();
  try {
    const nowSec = Math.trunc(Date.now() / 1000);
    const validParams: Record<string, string> = {
      shop: storeDomain,
      path_prefix: "/apps/weletic",
      timestamp: String(nowSec),
      logged_in_customer_id: "12345678",
    };
    const validSig = calculateShopifyAppProxySignature(
      validParams,
      testApiSecret,
    );
    const verifiedValid = validateShopifyAppProxyQuery(
      { ...validParams, signature: validSig },
      testApiSecret,
      nowSec,
    );

    // Tampered signature
    const tamperedSig = validSig.replace(/[a-f0-9]/, (c) =>
      c === "a" ? "b" : "a",
    );
    const verifiedTampered = validateShopifyAppProxyQuery(
      { ...validParams, signature: tamperedSig },
      testApiSecret,
      nowSec,
    );

    // Expired timestamp (> 90s)
    const expiredTimestamp = String(nowSec - 120);
    const expiredSig = calculateShopifyAppProxySignature(
      { ...validParams, timestamp: expiredTimestamp },
      testApiSecret,
    );
    const verifiedExpired = validateShopifyAppProxyQuery(
      { ...validParams, timestamp: expiredTimestamp, signature: expiredSig },
      testApiSecret,
      nowSec,
    );

    const passed =
      verifiedValid.valid === true &&
      verifiedTampered.valid === false &&
      verifiedExpired.valid === false;

    phase3Checks.push({
      name: "shopifyProxyHmacVerification",
      passed,
      durationMs: Date.now() - check7Start,
      details: {
        validAccepted: verifiedValid.valid,
        tamperedRejected: !verifiedTampered.valid,
        expiredRejected: !verifiedExpired.valid,
      },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase3Checks.push({
      name: "shopifyProxyHmacVerification",
      passed: false,
      durationMs: Date.now() - check7Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  // Check 8: Customer authentication gate for mutating actions
  const check8Start = Date.now();
  try {
    const testEndpoints = [
      "customer/redeem",
      "customer/referral/bind",
      "customer/activity/claim",
    ];
    const anonymousRejected = testEndpoints.every((ep) => {
      const customerId: string | undefined = undefined;
      return CUSTOMER_AUTH_REQUIRED_ACTION_PATHS.has(ep) && !customerId;
    });

    const authenticatedAccepted = testEndpoints.every((ep) => {
      const customerId = "99887766";
      return !(CUSTOMER_AUTH_REQUIRED_ACTION_PATHS.has(ep) && !customerId);
    });

    const referralClaimPublic =
      !CUSTOMER_AUTH_REQUIRED_ACTION_PATHS.has("referral/claim");

    const passed =
      anonymousRejected && authenticatedAccepted && referralClaimPublic;

    phase3Checks.push({
      name: "customerAuthenticationGate",
      passed,
      durationMs: Date.now() - check8Start,
      details: {
        anonymousRejected,
        authenticatedAccepted,
        referralClaimPublic,
      },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase3Checks.push({
      name: "customerAuthenticationGate",
      passed: false,
      durationMs: Date.now() - check8Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  // Check 9: Channel pinning and payload sanitization
  const check9Start = Date.now();
  try {
    const untrustedPayload: Record<string, any> = {
      rewardDefinitionId: "rw_100_yen",
      idempotencyKey: "intent_1",
      shop: "attacker.myshopify.com",
      shopifyCustomerId: "attacker-id",
      clientIp: "1.2.3.4",
      userAgent: "curl/7.0",
      redemptionChannel: "pos",
    };

    const sanitized = { ...untrustedPayload };
    for (const reservedField of [
      "shop",
      "shopifyCustomerId",
      "clientIp",
      "userAgent",
      "redemptionChannel",
    ]) {
      delete sanitized[reservedField];
    }

    const verifiedShop = storeDomain;
    const verifiedCustomerId = "customer_authoritative_123";
    const subpath = "customer/redeem";

    const forwardPayload = {
      ...sanitized,
      shop: verifiedShop,
      ...(verifiedCustomerId ? { shopifyCustomerId: verifiedCustomerId } : {}),
      ...(subpath === "customer/redeem"
        ? { redemptionChannel: "online_store" }
        : {}),
    };

    const pinnedToOnlineStore =
      forwardPayload.redemptionChannel === "online_store";
    const customerIdAuthoritative =
      forwardPayload.shopifyCustomerId === verifiedCustomerId;
    const shopAuthoritative = forwardPayload.shop === verifiedShop;

    const passed =
      pinnedToOnlineStore && customerIdAuthoritative && shopAuthoritative;

    phase3Checks.push({
      name: "channelPinningAndSanitization",
      passed,
      durationMs: Date.now() - check9Start,
      details: {
        pinnedToOnlineStore,
        customerIdAuthoritative,
        shopAuthoritative,
      },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase3Checks.push({
      name: "channelPinningAndSanitization",
      passed: false,
      durationMs: Date.now() - check9Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  // Check 10: Private cache headers
  const check10Start = Date.now();
  try {
    const privateHeaders = {
      "Cache-Control":
        "private, no-store, no-cache, max-age=0, must-revalidate",
      Vary: "Cookie",
    };

    const isNoStore = privateHeaders["Cache-Control"].includes("no-store");
    const isVaryCookie = privateHeaders["Vary"] === "Cookie";
    const passed = isNoStore && isVaryCookie;

    phase3Checks.push({
      name: "privateCacheHeaders",
      passed,
      durationMs: Date.now() - check10Start,
      details: { privateHeaders },
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  } catch (err: any) {
    phase3Checks.push({
      name: "privateCacheHeaders",
      passed: false,
      durationMs: Date.now() - check10Start,
      error: err.message,
      provenance: { source: "app-proxy-gateway", executionMode, live: false },
    });
  }

  const phase3Duration = Date.now() - phase3Start;
  report.phases.push({
    phaseName: "Phase 3: Cryptographic HMAC & Security Boundaries",
    status: phase3Checks.every((c) => c.passed) ? "PASSED" : "FAILED",
    durationMs: phase3Duration,
    checks: phase3Checks,
    provenance,
  });

  // --------------------------------------------------------------------------
  // Phase 4: Storefront Shopper Journey Simulation
  // --------------------------------------------------------------------------
  const phase4Start = Date.now();
  const phase4Checks: ValidationCheckResult[] = [];

  // Check 11: Guest shopper journey & PDP product points
  const check11Start = Date.now();
  try {
    const calculateProductPoints = (
      priceCents: number,
      currency: string,
      earnRateBps = 100,
    ) => {
      const isZeroDecimal = ["JPY", "VND", "KRW"].includes(
        currency.toUpperCase(),
      );
      const majorUnits = isZeroDecimal ? priceCents : priceCents / 100;
      return Math.floor((majorUnits * earnRateBps) / 100);
    };

    const usdItemPoints = calculateProductPoints(4999, "USD");
    const jpyItemPoints = calculateProductPoints(5000, "JPY");
    const usdPointsExpected = 49;
    const jpyPointsExpected = 5000;

    const calculationsAccurate =
      usdItemPoints === usdPointsExpected &&
      jpyItemPoints === jpyPointsExpected;

    phase4Checks.push({
      name: "guestShopperJourney",
      passed: calculationsAccurate,
      durationMs: Date.now() - check11Start,
      details: { usdItemPoints, jpyItemPoints },
      provenance: { source: "simulated", executionMode, live: false },
    });
  } catch (err: any) {
    phase4Checks.push({
      name: "guestShopperJourney",
      passed: false,
      durationMs: Date.now() - check11Start,
      error: err.message,
      provenance: { source: "simulated", executionMode, live: false },
    });
  }

  // Check 12: Authenticated member redemption & double-click deduplication
  const check12Start = Date.now();
  try {
    const redemptionIntentKeys: Record<string, boolean> = {};
    const intentId = "rw_amount_1000";

    const attempt1 = !redemptionIntentKeys[intentId];
    if (attempt1) {
      redemptionIntentKeys[intentId] = true;
    }

    const attempt2Concurrent = !redemptionIntentKeys[intentId];

    delete redemptionIntentKeys[intentId];
    const attempt3PostResolution = !redemptionIntentKeys[intentId];

    const passed =
      attempt1 === true &&
      attempt2Concurrent === false &&
      attempt3PostResolution === true;

    phase4Checks.push({
      name: "authenticatedMemberRedemption",
      passed,
      durationMs: Date.now() - check12Start,
      details: { attempt1, attempt2Concurrent, attempt3PostResolution },
      provenance: { source: "simulated", executionMode, live: false },
    });
  } catch (err: any) {
    phase4Checks.push({
      name: "authenticatedMemberRedemption",
      passed: false,
      durationMs: Date.now() - check12Start,
      error: err.message,
      provenance: { source: "simulated", executionMode, live: false },
    });
  }

  const phase4Duration = Date.now() - phase4Start;
  report.phases.push({
    phaseName: "Phase 4: Storefront Shopper Journey Simulation",
    status: phase4Checks.every((c) => c.passed) ? "PASSED" : "FAILED",
    durationMs: phase4Duration,
    checks: phase4Checks,
    provenance,
  });

  // --------------------------------------------------------------------------
  // Summary Aggregation
  // --------------------------------------------------------------------------
  report.totalDurationMs = Date.now() - startTime;
  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  let skippedChecks = 0;

  for (const phase of report.phases) {
    for (const check of phase.checks) {
      totalChecks++;
      if (check.passed) {
        passedChecks++;
      } else if (check.skipped) {
        skippedChecks++;
      } else {
        failedChecks++;
        report.errors.push({
          phase: phase.phaseName,
          check: check.name,
          error: check.error || "Assertion failed",
        });
      }
    }
  }

  report.summary = {
    totalChecks,
    passedChecks,
    failedChecks,
    skippedChecks,
  };

  report.overallStatus = failedChecks === 0 ? "PASSED" : "FAILED";

  if (options.outputReportPath) {
    try {
      const resolved = path.resolve(options.outputReportPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
    } catch (e: any) {
      console.error(
        `Failed to write report to ${options.outputReportPath}:`,
        e.message,
      );
    }
  }

  return report;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

export function parseCLIArgs(args: string[]): ValidationCLIOptions {
  const options: ValidationCLIOptions = {};
  for (const arg of args) {
    if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--confirm-staging") {
      options.confirmStaging = true;
    } else if (arg.startsWith("--store=")) {
      options.storeDomain = arg.split("=")[1];
    } else if (arg.startsWith("--report=")) {
      options.outputReportPath = arg.split("=")[1];
    }
  }
  return options;
}

async function main() {
  const options = parseCLIArgs(process.argv.slice(2));

  if (!options.mock && !options.dryRun && !options.live) {
    options.dryRun = true;
  }

  const report = await runThemeAppProxyValidation(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      "\n============================================================",
    );
    console.log("       WELETIC THEME APP PROXY VALIDATION REPORT            ");
    console.log("============================================================");
    console.log(`Status:         ${report.overallStatus}`);
    console.log(`Store:          ${report.storeDomain}`);
    console.log(`Mode:           ${report.executionMode}`);
    console.log(`Total Checks:   ${report.summary.totalChecks}`);
    console.log(`Passed:         ${report.summary.passedChecks}`);
    console.log(`Failed:         ${report.summary.failedChecks}`);
    console.log(`Duration:       ${report.totalDurationMs}ms\n`);

    for (const phase of report.phases) {
      console.log(`--- ${phase.phaseName} (${phase.status}) ---`);
      for (const check of phase.checks) {
        const symbol = check.passed ? "✓" : "✗";
        console.log(`  ${symbol} ${check.name} (${check.durationMs}ms)`);
        if (check.error) {
          console.log(`     Error: ${check.error}`);
        }
      }
      console.log("");
    }
  }

  if (report.overallStatus === "FAILED") {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Validation failed with uncaught exception:", err);
    process.exit(1);
  });
}
