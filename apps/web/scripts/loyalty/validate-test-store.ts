import {
  createBasicDiscount,
  createBxgyDiscount,
  createFreeShippingDiscount,
  deactivateDiscount,
  deleteDiscount,
  lookupDiscountByCode,
  resolveShopifyOfflineCredentials,
  shopifyAdminGraphqlRequest,
  type ShopifyDiscountResult,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  ensureShopifyWebhooksRegistered,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
} from "@/lib/weletic/shopify/provision-webhooks";
import {
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import {
  normalizeShopDomain,
  resolveShopifyStoreByDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types & Report Interfaces
// ============================================================================

export type ValidationExecutionMode = "dry-run" | "mock" | "live-admin";

export type ValidationEvidenceSource =
  | "local-static"
  | "persisted-database"
  | "mocked-shopify-adapter"
  | "shopify-admin-api"
  | "not-executed"
  | "mixed";

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
  provenance?: ValidationEvidenceProvenance;
}

export interface ValidationPhaseResult {
  phase: string;
  passed: boolean;
  durationMs: number;
  checks: ValidationCheckResult[];
  provenance: ValidationEvidenceProvenance;
}

export interface TestStoreValidationReport {
  timestamp: string;
  storeDomain: string;
  executionMode: ValidationExecutionMode;
  /** @deprecated Read executionMode for evidence semantics. */
  environment: string;
  overallStatus: "PASSED" | "FAILED" | "WARNING";
  totalDurationMs: number;
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    skippedChecks: number;
  };
  phases: {
    domainResolution: ValidationPhaseResult;
    localServiceHmacChecks: ValidationPhaseResult;
    staticCustomerAccountClaimChecks: ValidationPhaseResult;
    graphqlDiscounts: ValidationPhaseResult;
    webhookProvisioning: ValidationPhaseResult;
  };
  errors: Array<{ phase: string; check: string; error: string }>;
}

export interface ValidationCLIOptions {
  storeDomain?: string;
  dryRun?: boolean;
  mockShopify?: boolean;
  skipDiscounts?: boolean;
  skipWebhooks?: boolean;
  cleanup?: boolean;
  verbose?: boolean;
  outputReportPath?: string;
  customFetch?: typeof fetch;
  serviceSecret?: string;
  webhookSecret?: string;
}

function skippedCheck(name: string, reason: string): ValidationCheckResult {
  return {
    name,
    passed: false,
    skipped: true,
    durationMs: 0,
    details: { reason },
  };
}

function evidenceProvenance(
  source: ValidationEvidenceSource,
  executionMode: ValidationExecutionMode,
): ValidationEvidenceProvenance {
  return {
    source,
    executionMode,
    live: source === "shopify-admin-api" && executionMode === "live-admin",
  };
}

function finalizePhase(
  phase: Omit<ValidationPhaseResult, "provenance">,
  provenance: ValidationEvidenceProvenance,
): ValidationPhaseResult {
  return {
    ...phase,
    provenance,
    checks: phase.checks.map((check) => ({
      ...check,
      provenance: check.provenance || provenance,
    })),
  };
}

function skippedPhase(
  phase: string,
  checks: string[],
  reason: string,
  executionMode: ValidationExecutionMode = "dry-run",
): ValidationPhaseResult {
  return finalizePhase(
    {
      phase,
      passed: true,
      durationMs: 0,
      checks: checks.map((name) => skippedCheck(name, reason)),
    },
    evidenceProvenance("not-executed", executionMode),
  );
}

function failedPhase(
  phase: string,
  check: string,
  error: string,
  provenance: ValidationEvidenceProvenance = evidenceProvenance(
    "local-static",
    "mock",
  ),
): ValidationPhaseResult {
  return finalizePhase(
    {
      phase,
      passed: false,
      durationMs: 0,
      checks: [{ name: check, passed: false, durationMs: 0, error }],
    },
    provenance,
  );
}

// ============================================================================
// Phase 1: Store Domain & Workspace Resolution
// ============================================================================

export async function validateDomainResolution(
  targetDomain: string,
  options: {
    dryRun?: boolean;
    mockShopify?: boolean;
    executionMode?: ValidationExecutionMode;
  } = {},
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const executionMode =
    options.executionMode ||
    (options.dryRun ? "dry-run" : options.mockShopify ? "mock" : "live-admin");

  // Check 1.1: Domain Normalization
  const normStart = Date.now();
  try {
    const rawVariants = [
      `https://${targetDomain}/`,
      `http://${targetDomain}`,
      `  ${targetDomain.toUpperCase()}  `,
      targetDomain,
    ];
    const normalizedList = rawVariants.map(normalizeShopDomain);
    const expected = targetDomain.toLowerCase().trim();
    const allMatch = normalizedList.every((d) => d === expected);

    checks.push({
      name: "Domain String Normalization",
      passed: allMatch,
      durationMs: Date.now() - normStart,
      details: { targetDomain, normalizedList },
      provenance: evidenceProvenance("local-static", executionMode),
    });
  } catch (err: any) {
    checks.push({
      name: "Domain String Normalization",
      passed: false,
      durationMs: Date.now() - normStart,
      error: err.message || String(err),
      provenance: evidenceProvenance("local-static", executionMode),
    });
  }

  // Check 1.2: Canonical Store Resolution via resolveShopifyStoreByDomain
  const resStart = Date.now();
  try {
    const resolved = await resolveShopifyStoreByDomain(targetDomain);
    const passed = Boolean(
      resolved &&
        resolved.workspaceId &&
        resolved.storeId &&
        resolved.myshopifyDomain &&
        resolved.accessToken,
    );

    checks.push({
      name: "Canonical Store Resolution (DB / InstalledIntegration)",
      passed,
      durationMs: Date.now() - resStart,
      details: resolved
        ? {
            hasWorkspace: Boolean(resolved.workspaceId),
            hasStore: Boolean(resolved.storeId),
            hasProgram: Boolean(resolved.programId),
            domainMatchesTarget:
              resolved.myshopifyDomain === targetDomain.toLowerCase(),
            hasAccessToken: Boolean(resolved.accessToken),
          }
        : { message: "Store not found in exact database records" },
      error: passed
        ? undefined
        : "Unable to resolve an exact store record and offline credential for target domain",
      provenance: evidenceProvenance("persisted-database", executionMode),
    });
  } catch (err: any) {
    checks.push({
      name: "Canonical Store Resolution (DB / InstalledIntegration)",
      passed: false,
      durationMs: Date.now() - resStart,
      error: err.message || String(err),
      provenance: evidenceProvenance("persisted-database", executionMode),
    });
  }

  const phasePassed = checks.every((c) => c.passed);
  return finalizePhase(
    {
      phase: "Store Domain & Workspace Resolution",
      passed: phasePassed,
      durationMs: Date.now() - startTime,
      checks,
    },
    evidenceProvenance("mixed", executionMode),
  );
}

// ============================================================================
// Phase 2: Local Service-HMAC Cryptographic Checks
// ============================================================================

export async function validateLocalServiceHmacChecks(
  targetDomain: string,
  serviceSecret?: string,
  executionMode: ValidationExecutionMode = "mock",
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const secret = (
    serviceSecret ||
    process.env.WELETIC_SHOPIFY_SERVICE_SECRET ||
    ""
  ).trim();
  if (secret.length < 32) {
    return failedPhase(
      "Local Service-HMAC Cryptographic Checks",
      "Explicit Service-HMAC Secret Availability",
      "WELETIC_SHOPIFY_SERVICE_SECRET or an explicit serviceSecret of at least 32 characters is required",
      evidenceProvenance("local-static", executionMode),
    );
  }

  // Check 2.1: Canonical HMAC Signing & Timing-Safe Verification
  const signStart = Date.now();
  try {
    const timestamp = String(Date.now());
    const method = "GET";
    const pathUrl = `/api/internal/shopify/loyalty/customer?shop=${encodeURIComponent(targetDomain)}&customerId=cust_12345`;
    const body = "";

    const signature = signWeleticShopifyRequest({
      timestamp,
      method,
      path: pathUrl,
      body,
      secret,
    });

    const mockRequest = new Request(`https://app.weletic.com${pathUrl}`, {
      method,
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
      },
    });

    const isValid = verifyWeleticShopifyRequest({
      request: mockRequest,
      body,
      now: Number(timestamp),
      secret,
    });

    checks.push({
      name: "Local Service-HMAC SHA-256 Round Trip",
      passed: isValid && signature.length === 64,
      durationMs: Date.now() - signStart,
      details: { signatureLength: signature.length, timestamp },
    });
  } catch (err: any) {
    checks.push({
      name: "Local Service-HMAC SHA-256 Round Trip",
      passed: false,
      durationMs: Date.now() - signStart,
      error: err.message || String(err),
    });
  }

  // Check 2.2: Clock Skew Enforcement (> 5 min skew rejected)
  const skewStart = Date.now();
  try {
    const expiredTimestamp = String(
      Date.now() - (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 60000),
    );
    const pathUrl = `/api/internal/shopify/loyalty/program?shop=${encodeURIComponent(targetDomain)}`;
    const signature = signWeleticShopifyRequest({
      timestamp: expiredTimestamp,
      method: "GET",
      path: pathUrl,
      body: "",
      secret,
    });

    const expiredReq = new Request(`https://app.weletic.com${pathUrl}`, {
      method: "GET",
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: expiredTimestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
      },
    });

    const isRejected = !verifyWeleticShopifyRequest({
      request: expiredReq,
      body: "",
      now: Date.now(),
      secret,
    });

    checks.push({
      name: "Local Service-HMAC Clock-Skew Rejection (> 5 min)",
      passed: isRejected,
      durationMs: Date.now() - skewStart,
    });
  } catch (err: any) {
    checks.push({
      name: "Local Service-HMAC Clock-Skew Rejection (> 5 min)",
      passed: false,
      durationMs: Date.now() - skewStart,
      error: err.message || String(err),
    });
  }

  // Check 2.3: Payload Tamper Resistance
  const tamperStart = Date.now();
  try {
    const timestamp = String(Date.now());
    const pathUrl = `/api/internal/shopify/loyalty/customer/redeem?shop=${encodeURIComponent(targetDomain)}`;
    const originalBody = JSON.stringify({
      rewardId: "rew_123",
      pointsCost: "500",
    });
    const signature = signWeleticShopifyRequest({
      timestamp,
      method: "POST",
      path: pathUrl,
      body: originalBody,
      secret,
    });

    const tamperedBody = JSON.stringify({
      rewardId: "rew_123",
      pointsCost: "0",
    });
    const req = new Request(`https://app.weletic.com${pathUrl}`, {
      method: "POST",
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
      },
      body: tamperedBody,
    });

    const isTamperRejected = !verifyWeleticShopifyRequest({
      request: req,
      body: tamperedBody,
      now: Number(timestamp),
      secret,
    });

    checks.push({
      name: "Local Service-HMAC Payload-Tamper Rejection",
      passed: isTamperRejected,
      durationMs: Date.now() - tamperStart,
    });
  } catch (err: any) {
    checks.push({
      name: "Local Service-HMAC Payload-Tamper Rejection",
      passed: false,
      durationMs: Date.now() - tamperStart,
      error: err.message || String(err),
    });
  }

  const phasePassed = checks.every((c) => c.passed);
  return finalizePhase(
    {
      phase: "Local Service-HMAC Cryptographic Checks",
      passed: phasePassed,
      durationMs: Date.now() - startTime,
      checks,
    },
    evidenceProvenance("local-static", executionMode),
  );
}

// ============================================================================
// Phase 3: Static Customer Account Claim Parser Checks
// ============================================================================

export function validateCustomerAccountSessionClaims(sessionToken: {
  dest?: string;
  sub?: string;
}): { valid: boolean; shop?: string; customerId?: string; error?: string } {
  if (!sessionToken?.dest || !sessionToken?.sub) {
    return { valid: false, error: "Missing required dest or sub claims" };
  }

  let shop: string;
  try {
    const url = new URL(
      sessionToken.dest.startsWith("http")
        ? sessionToken.dest
        : `https://${sessionToken.dest}`,
    );
    shop = url.hostname.toLowerCase();
  } catch {
    return { valid: false, error: "Malformed destination claim" };
  }

  let customerId = sessionToken.sub;
  if (customerId.startsWith("gid://shopify/Customer/")) {
    customerId = customerId.replace("gid://shopify/Customer/", "");
  }

  const isShopifyDomain = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
  const isNumericCustomerId = /^\d+$/.test(customerId);

  if (!isShopifyDomain || !isNumericCustomerId) {
    return {
      valid: false,
      error: "Malformed Shopify shop or customer identity claim",
    };
  }

  return { valid: true, shop, customerId };
}

export async function validateStaticCustomerAccountClaimChecks(
  targetDomain: string,
  executionMode: ValidationExecutionMode = "mock",
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];

  // Check 3.1: Valid Claims Parsing & Extraction
  const validStart = Date.now();
  try {
    const testClaims = {
      dest: `https://${targetDomain}`,
      sub: "gid://shopify/Customer/9988776655",
    };
    const parsed = validateCustomerAccountSessionClaims(testClaims);
    const passed =
      parsed.valid &&
      parsed.shop === targetDomain.toLowerCase() &&
      parsed.customerId === "9988776655";

    checks.push({
      name: "Static Customer Account Claim Extraction (dest & sub GID)",
      passed,
      durationMs: Date.now() - validStart,
      details: {
        valid: parsed.valid,
        shopMatchesTarget: parsed.shop === targetDomain.toLowerCase(),
        numericCustomerIdAccepted: /^\d+$/.test(parsed.customerId || ""),
      },
    });
  } catch (err: any) {
    checks.push({
      name: "Static Customer Account Claim Extraction (dest & sub GID)",
      passed: false,
      durationMs: Date.now() - validStart,
      error: err.message || String(err),
    });
  }

  // Check 3.2: Rejection of Missing dest or sub
  const invalidStart = Date.now();
  try {
    const missingDest = validateCustomerAccountSessionClaims({
      sub: "gid://shopify/Customer/1",
    });
    const missingSub = validateCustomerAccountSessionClaims({
      dest: `https://${targetDomain}`,
    });
    const emptyClaims = validateCustomerAccountSessionClaims({});

    const allRejected =
      !missingDest.valid && !missingSub.valid && !emptyClaims.valid;

    checks.push({
      name: "Static Rejection of Malformed / Incomplete Claims",
      passed: allRejected,
      durationMs: Date.now() - invalidStart,
    });
  } catch (err: any) {
    checks.push({
      name: "Static Rejection of Malformed / Incomplete Claims",
      passed: false,
      durationMs: Date.now() - invalidStart,
      error: err.message || String(err),
    });
  }

  const phasePassed = checks.every((c) => c.passed);
  return finalizePhase(
    {
      phase: "Static Customer Account Claim Parser Checks",
      passed: phasePassed,
      durationMs: Date.now() - startTime,
      checks,
    },
    evidenceProvenance("local-static", executionMode),
  );
}

// ============================================================================
// Phase 4: Shopify GraphQL Admin API 2026-07 Discount Code Lifecycle
// ============================================================================

type ValidationDiscountKind =
  | "basic_amount"
  | "basic_percentage"
  | "free_shipping"
  | "bxgy";

interface ExpectedValidationDiscount {
  kind: ValidationDiscountKind;
  code: string;
  title: string;
  runNonce: string;
  startsAt: string;
  currencyCode?: string;
  productGid?: string;
}

interface ValidationDiscountReadback {
  id: string;
  code: string;
  title: string;
  status: string;
  kind: ValidationDiscountKind | "unsupported";
  configuration: Record<string, any> | null;
}

interface DispatchedValidationCreate {
  expected: ExpectedValidationDiscount;
  dispatched: boolean;
  resolvedGid: string | null;
}

const VALIDATION_DISCOUNT_NODE_BY_ID_QUERY = `
query WeleticValidationNodeById($id: ID!) {
  node(id: $id) {
    id
  }
}
`;

const VALIDATION_SHOP_CURRENCY_QUERY = `
query WeleticValidationShopCurrency {
  shop {
    currencyCode
  }
}
`;

const VALIDATION_BXGY_READBACK_QUERY = `
query WeleticValidationBxgyReadback($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      ... on DiscountCodeBxgy {
        __typename
        title
        status
        startsAt
        endsAt
        usageLimit
        usesPerOrderLimit
        appliesOncePerCustomer
        combinesWith {
          orderDiscounts
          productDiscounts
          shippingDiscounts
        }
        customerSelection {
          __typename
          ... on DiscountCustomerAll {
            allCustomers
          }
        }
        customerBuys {
          value {
            ... on DiscountQuantity {
              quantity
            }
          }
          items {
            __typename
            ... on DiscountProducts {
              products(first: 10) {
                nodes { id }
                pageInfo { hasNextPage }
              }
            }
          }
        }
        customerGets {
          value {
            ... on DiscountOnQuantity {
              quantity { quantity }
              effect {
                __typename
                ... on DiscountPercentage { percentage }
              }
            }
          }
          items {
            __typename
            ... on DiscountProducts {
              products(first: 10) {
                nodes { id }
                pageInfo { hasNextPage }
              }
            }
          }
        }
        codes(first: 10) {
          nodes { code }
        }
      }
    }
  }
}
`;

function hasFalseCombinations(value: any) {
  return (
    value?.orderDiscounts === false &&
    value?.productDiscounts === false &&
    value?.shippingDiscounts === false
  );
}

function sameValidationInstant(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  return (
    Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs
  );
}

function deriveStandardDiscountKind(
  remote: ShopifyDiscountResult,
): ValidationDiscountKind | "unsupported" {
  if (remote.configuration?.kind === "free_shipping") {
    return "free_shipping";
  }
  if (
    remote.configuration?.kind === "basic" &&
    remote.configuration.basicValue?.kind === "amount"
  ) {
    return "basic_amount";
  }
  if (
    remote.configuration?.kind === "basic" &&
    remote.configuration.basicValue?.kind === "percentage"
  ) {
    return "basic_percentage";
  }
  return "unsupported";
}

function normalizeStandardReadback(
  remote: ShopifyDiscountResult,
): ValidationDiscountReadback {
  return {
    id: remote.id,
    code: remote.code,
    title: remote.title,
    status: remote.status,
    kind: deriveStandardDiscountKind(remote),
    configuration: remote.configuration || null,
  };
}

export function matchesExpectedValidationDiscount(
  remote: ValidationDiscountReadback,
  expected: ExpectedValidationDiscount,
  options: { requireActive?: boolean } = {},
): boolean {
  const requireActive = options.requireActive !== false;
  const hasStrongRunMarker =
    /^[A-F0-9]{32}$/.test(expected.runNonce) &&
    expected.code.endsWith(expected.runNonce) &&
    expected.title.endsWith(expected.runNonce);
  if (
    !hasStrongRunMarker ||
    remote.code.trim().toUpperCase() !== expected.code ||
    remote.title !== expected.title ||
    (requireActive && remote.status !== "ACTIVE") ||
    remote.kind !== expected.kind ||
    !remote.configuration
  ) {
    return false;
  }

  const configuration = remote.configuration;
  const commonMatches =
    sameValidationInstant(configuration.startsAt, expected.startsAt) &&
    configuration.endsAt === null &&
    configuration.usageLimit === 1 &&
    configuration.appliesOncePerCustomer === true &&
    hasFalseCombinations(configuration.combinesWith);
  if (!commonMatches) return false;

  if (expected.kind === "basic_amount") {
    return (
      configuration.customerSelection?.kind === "all" &&
      configuration.minimumRequirement === null &&
      configuration.appliesOnOneTimePurchase === true &&
      configuration.appliesOnSubscription === false &&
      configuration.basicItems?.kind === "all" &&
      configuration.basicValue?.kind === "amount" &&
      Number(configuration.basicValue.amount) === 10 &&
      typeof expected.currencyCode === "string" &&
      /^[A-Z]{3}$/.test(expected.currencyCode) &&
      configuration.basicValue.currencyCode === expected.currencyCode &&
      configuration.basicValue.appliesOnEachItem === false
    );
  }

  if (expected.kind === "basic_percentage") {
    return (
      configuration.customerSelection?.kind === "all" &&
      configuration.minimumRequirement === null &&
      configuration.appliesOnOneTimePurchase === true &&
      configuration.appliesOnSubscription === false &&
      configuration.basicItems?.kind === "all" &&
      configuration.basicValue?.kind === "percentage" &&
      configuration.basicValue.percentage === 0.1
    );
  }

  if (expected.kind === "free_shipping") {
    return (
      configuration.customerSelection?.kind === "all" &&
      configuration.minimumRequirement === null &&
      configuration.appliesOnOneTimePurchase === true &&
      configuration.appliesOnSubscription === false &&
      configuration.maximumShippingPrice === null &&
      configuration.shippingDestination?.kind === "all"
    );
  }

  return (
    configuration.customerSelectionAll === true &&
    configuration.usesPerOrderLimit === 1 &&
    configuration.buyQuantity === "1" &&
    configuration.getQuantity === "1" &&
    configuration.getPercentage === 1 &&
    configuration.buyProductsTruncated === false &&
    configuration.getProductsTruncated === false &&
    expected.productGid !== undefined &&
    configuration.buyProductIds?.length === 1 &&
    configuration.buyProductIds[0] === expected.productGid &&
    configuration.getProductIds?.length === 1 &&
    configuration.getProductIds[0] === expected.productGid
  );
}

export async function lookupValidationDiscountNodeById(
  targetDomain: string,
  accessToken: string,
  gid: string,
  customFetch?: typeof fetch,
): Promise<{ id: string } | null> {
  const response = await shopifyAdminGraphqlRequest<{
    node?: { id?: string | null } | null;
  }>({
    shopDomain: targetDomain,
    accessToken,
    query: VALIDATION_DISCOUNT_NODE_BY_ID_QUERY,
    variables: { id: gid },
    customFetch,
  });
  return typeof response?.node?.id === "string"
    ? { id: response.node.id }
    : null;
}

async function lookupValidationBxgyByCode(
  targetDomain: string,
  accessToken: string,
  code: string,
  customFetch?: typeof fetch,
): Promise<ValidationDiscountReadback | null> {
  const response = await shopifyAdminGraphqlRequest<any>({
    shopDomain: targetDomain,
    accessToken,
    query: VALIDATION_BXGY_READBACK_QUERY,
    variables: { code },
    customFetch,
  });
  const node = response?.codeDiscountNodeByCode;
  const discount = node?.codeDiscount;
  if (!node?.id || discount?.__typename !== "DiscountCodeBxgy") return null;
  const matchedCode = discount.codes?.nodes?.find(
    (candidate: any) => candidate?.code?.trim().toUpperCase() === code,
  )?.code;
  const buyProducts = discount.customerBuys?.items?.products;
  const getProducts = discount.customerGets?.items?.products;
  return {
    id: node.id,
    code: matchedCode || "",
    title: discount.title || "",
    status: discount.status || "",
    kind: "bxgy",
    configuration: {
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      usageLimit: discount.usageLimit,
      usesPerOrderLimit: discount.usesPerOrderLimit,
      appliesOncePerCustomer: discount.appliesOncePerCustomer,
      combinesWith: discount.combinesWith,
      customerSelectionAll:
        discount.customerSelection?.__typename === "DiscountCustomerAll" &&
        discount.customerSelection?.allCustomers === true,
      buyQuantity: discount.customerBuys?.value?.quantity,
      buyProductIds: Array.isArray(buyProducts?.nodes)
        ? buyProducts.nodes.map((product: any) => product?.id)
        : [],
      buyProductsTruncated: buyProducts?.pageInfo?.hasNextPage !== false,
      getQuantity: discount.customerGets?.value?.quantity?.quantity,
      getPercentage:
        discount.customerGets?.value?.effect?.__typename ===
        "DiscountPercentage"
          ? discount.customerGets.value.effect.percentage
          : null,
      getProductIds: Array.isArray(getProducts?.nodes)
        ? getProducts.nodes.map((product: any) => product?.id)
        : [],
      getProductsTruncated: getProducts?.pageInfo?.hasNextPage !== false,
    },
  };
}

export async function lookupExpectedValidationDiscount(
  targetDomain: string,
  accessToken: string,
  expected: ExpectedValidationDiscount,
  customFetch?: typeof fetch,
): Promise<ValidationDiscountReadback | null> {
  if (expected.kind === "bxgy") {
    return lookupValidationBxgyByCode(
      targetDomain,
      accessToken,
      expected.code,
      customFetch,
    );
  }
  const remote = await lookupDiscountByCode(
    targetDomain,
    accessToken,
    expected.code,
    customFetch,
  );
  return remote ? normalizeStandardReadback(remote) : null;
}

async function reconcileValidationCreate(
  targetDomain: string,
  accessToken: string,
  expected: ExpectedValidationDiscount,
  createReturnedGid: string | null,
  customFetch?: typeof fetch,
): Promise<ValidationDiscountReadback | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remote = await lookupExpectedValidationDiscount(
        targetDomain,
        accessToken,
        expected,
        customFetch,
      );
      if (!remote) continue;
      if (createReturnedGid && remote.id !== createReturnedGid) return null;
      return matchesExpectedValidationDiscount(remote, expected)
        ? remote
        : null;
    } catch {
      // Bounded reconciliation deliberately retries only this exact run code.
    }
  }
  return null;
}

export async function validateShopifyDiscountsLifecycle(
  targetDomain: string,
  accessToken: string,
  options: {
    dryRun?: boolean;
    cleanup?: boolean;
    customFetch?: typeof fetch;
    executionMode?: ValidationExecutionMode;
  } = {},
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const executionMode =
    options.executionMode || (options.dryRun ? "dry-run" : "live-admin");
  const shopifyProvenance = evidenceProvenance(
    executionMode === "mock"
      ? "mocked-shopify-adapter"
      : executionMode === "live-admin"
        ? "shopify-admin-api"
        : "not-executed",
    executionMode,
  );

  if (options.dryRun) {
    return skippedPhase(
      "Shopify GraphQL Admin API 2026-07 Discount Lifecycle",
      [
        "Shopify GraphQL 2026-07: discountCodeBasicCreate",
        "Shopify GraphQL 2026-07: discountCodeBasicCreate (Percentage Off)",
        "Shopify GraphQL 2026-07: discountCodeFreeShippingCreate",
        "Shopify GraphQL 2026-07: discountCodeBxgyCreate",
        "Shopify GraphQL 2026-07: Authoritative Shop Currency Readback",
        "Shopify GraphQL 2026-07: Independent Exact Configuration Readback",
        "Discount Cleanup (Deactivate & Delete)",
      ],
      "Dry-run mode does not call or mutate Shopify",
      executionMode,
    );
  }

  const currencyStartedAt = Date.now();
  let authoritativeCurrencyCode: string;
  try {
    const currencyData = await shopifyAdminGraphqlRequest<{
      shop?: { currencyCode?: string | null } | null;
    }>({
      shopDomain: targetDomain,
      accessToken,
      query: VALIDATION_SHOP_CURRENCY_QUERY,
      customFetch: options.customFetch,
    });
    const candidate = currencyData.shop?.currencyCode;
    if (typeof candidate !== "string" || !/^[A-Z]{3}$/.test(candidate)) {
      throw new Error("Invalid Shopify shop currency readback");
    }
    authoritativeCurrencyCode = candidate;
    checks.push({
      name: "Shopify GraphQL 2026-07: Authoritative Shop Currency Readback",
      passed: true,
      durationMs: Date.now() - currencyStartedAt,
      details: { currencyCodeReadBack: true },
      provenance: shopifyProvenance,
    });
  } catch {
    checks.push({
      name: "Shopify GraphQL 2026-07: Authoritative Shop Currency Readback",
      passed: false,
      durationMs: Date.now() - currencyStartedAt,
      error:
        "Unable to bind validation economics to the authoritative Shopify shop currency",
      provenance: shopifyProvenance,
    });
    return finalizePhase(
      {
        phase: "Shopify GraphQL Admin API 2026-07 Discount Lifecycle",
        passed: false,
        durationMs: Date.now() - startTime,
        checks,
      },
      shopifyProvenance,
    );
  }

  const runNonce = crypto.randomBytes(16).toString("hex").toUpperCase();
  // Shopify canonicalizes Admin API timestamps to whole seconds on readback.
  // Bind the create request to that same precision so exact reconciliation is
  // stable without weakening any title, code, identity, or economics check.
  const startsAt = new Date(
    Math.floor(Date.now() / 1_000) * 1_000,
  ).toISOString();
  const expectedDiscounts: ExpectedValidationDiscount[] = [
    {
      kind: "basic_amount",
      code: `VAL-BASIC-${runNonce}`,
      title: `Validation Basic Discount ${runNonce}`,
      runNonce,
      startsAt,
      currencyCode: authoritativeCurrencyCode,
    },
    {
      kind: "basic_percentage",
      code: `VAL-PERCENT-${runNonce}`,
      title: `Validation Percentage Discount ${runNonce}`,
      runNonce,
      startsAt,
    },
    {
      kind: "free_shipping",
      code: `VAL-SHIP-${runNonce}`,
      title: `Validation Free Shipping ${runNonce}`,
      runNonce,
      startsAt,
    },
  ];
  const dispatchedCreates: DispatchedValidationCreate[] = [];
  const cleanupAuthorities = new Map<string, ExpectedValidationDiscount>();

  const executeValidationCreate = async (params: {
    name: string;
    expected: ExpectedValidationDiscount;
    create: () => Promise<ShopifyDiscountResult>;
  }) => {
    const checkStartedAt = Date.now();
    try {
      const preflight = await lookupDiscountByCode(
        targetDomain,
        accessToken,
        params.expected.code,
        options.customFetch,
      );
      if (preflight) {
        checks.push({
          name: params.name,
          passed: false,
          durationMs: Date.now() - checkStartedAt,
          error: "Unique validation code already exists before create dispatch",
          provenance: shopifyProvenance,
        });
        return;
      }
    } catch {
      checks.push({
        name: params.name,
        passed: false,
        durationMs: Date.now() - checkStartedAt,
        error: "Unable to prove validation code absence before create dispatch",
        provenance: shopifyProvenance,
      });
      return;
    }

    const dispatched: DispatchedValidationCreate = {
      expected: params.expected,
      dispatched: true,
      resolvedGid: null,
    };
    dispatchedCreates.push(dispatched);
    let result: ShopifyDiscountResult | null = null;
    let createThrew = false;
    try {
      result = await params.create();
    } catch {
      createThrew = true;
    }

    const createResponseMatches =
      result === null ||
      (result.code.trim().toUpperCase() === params.expected.code &&
        result.title === params.expected.title &&
        result.status === "ACTIVE");
    const remote = createResponseMatches
      ? await reconcileValidationCreate(
          targetDomain,
          accessToken,
          params.expected,
          result?.id || null,
          options.customFetch,
        )
      : null;
    if (remote) {
      cleanupAuthorities.set(remote.id, params.expected);
      dispatched.resolvedGid = remote.id;
    }

    checks.push({
      name: params.name,
      passed: Boolean(remote),
      durationMs: Date.now() - checkStartedAt,
      details: {
        preflightCodeAbsent: true,
        createDispatched: true,
        outcome: remote
          ? createThrew
            ? "reconciled-after-unknown-create"
            : "created-and-read-back"
          : "unresolved",
        configurationReadBack: Boolean(remote),
      },
      error: remote
        ? undefined
        : "Create outcome could not be bound to the exact run marker and immutable configuration",
      provenance: shopifyProvenance,
    });
  };

  // Check 4.1: discountCodeBasicCreate (Amount Off)
  const basicExpected = expectedDiscounts[0];
  await executeValidationCreate({
    name: "Shopify GraphQL 2026-07: discountCodeBasicCreate",
    expected: basicExpected,
    create: () =>
      createBasicDiscount({
        shopDomain: targetDomain,
        accessToken,
        code: basicExpected.code,
        title: basicExpected.title,
        valueType: "fixed_amount",
        value: 10.0,
        startsAt: basicExpected.startsAt,
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customFetch: options.customFetch,
      }),
  });

  // Check 4.2: discountCodeBasicCreate (Percentage Off)
  const percentageExpected = expectedDiscounts[1];
  await executeValidationCreate({
    name: "Shopify GraphQL 2026-07: discountCodeBasicCreate (Percentage Off)",
    expected: percentageExpected,
    create: () =>
      createBasicDiscount({
        shopDomain: targetDomain,
        accessToken,
        code: percentageExpected.code,
        title: percentageExpected.title,
        valueType: "percentage",
        value: 10,
        startsAt: percentageExpected.startsAt,
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customFetch: options.customFetch,
      }),
  });

  // Check 4.3: discountCodeFreeShippingCreate
  const shippingExpected = expectedDiscounts[2];
  await executeValidationCreate({
    name: "Shopify GraphQL 2026-07: discountCodeFreeShippingCreate",
    expected: shippingExpected,
    create: () =>
      createFreeShippingDiscount({
        shopDomain: targetDomain,
        accessToken,
        code: shippingExpected.code,
        title: shippingExpected.title,
        startsAt: shippingExpected.startsAt,
        usageLimit: 1,
        customFetch: options.customFetch,
      }),
  });

  // Check 4.4: discountCodeBxgyCreate (Buy X Get Y)
  const bxgyStart = Date.now();
  try {
    const productData = await shopifyAdminGraphqlRequest<{
      products: { nodes: Array<{ id: string }> };
    }>({
      shopDomain: targetDomain,
      accessToken,
      query: `query WeleticValidationProduct {
        products(first: 1) {
          nodes {
            id
          }
        }
      }`,
      customFetch: options.customFetch,
    });
    const validationProductGid = productData.products.nodes[0]?.id;
    if (!validationProductGid) {
      throw new Error(
        "BXGY validation requires at least one product in the Shopify test store.",
      );
    }
    const bxgyExpected: ExpectedValidationDiscount = {
      kind: "bxgy",
      code: `VAL-BXGY-${runNonce}`,
      title: `Validation BXGY Free Gift ${runNonce}`,
      runNonce,
      startsAt,
      productGid: validationProductGid,
    };
    expectedDiscounts.push(bxgyExpected);
    await executeValidationCreate({
      name: "Shopify GraphQL 2026-07: discountCodeBxgyCreate",
      expected: bxgyExpected,
      create: () =>
        createBxgyDiscount({
          shopDomain: targetDomain,
          accessToken,
          code: bxgyExpected.code,
          title: bxgyExpected.title,
          startsAt: bxgyExpected.startsAt,
          buyQuantity: 1,
          buyProductGids: [validationProductGid],
          getQuantity: 1,
          getProductGids: [validationProductGid],
          discountEffectType: "percentage",
          discountEffectValue: 100,
          usesPerOrderLimit: 1,
          usageLimit: 1,
          appliesOncePerCustomer: true,
          customFetch: options.customFetch,
        }),
    });
  } catch {
    checks.push({
      name: "Shopify GraphQL 2026-07: discountCodeBxgyCreate",
      passed: false,
      durationMs: Date.now() - bxgyStart,
      error:
        "BXGY validation could not prove product availability and exact configuration",
      provenance: shopifyProvenance,
    });
  }

  // Check 4.5: independent exact configuration readback
  const queryStart = Date.now();
  let exactReadbacks = 0;
  for (const expected of expectedDiscounts) {
    const authority = [...cleanupAuthorities.entries()].find(
      ([, candidate]) => candidate.code === expected.code,
    );
    if (!authority) continue;
    try {
      const remote = await lookupExpectedValidationDiscount(
        targetDomain,
        accessToken,
        expected,
        options.customFetch,
      );
      if (
        remote?.id === authority[0] &&
        matchesExpectedValidationDiscount(remote, expected)
      ) {
        exactReadbacks += 1;
      }
    } catch {
      // The aggregate check below fails without exposing raw remote errors.
    }
  }
  checks.push({
    name: "Shopify GraphQL 2026-07: Independent Exact Configuration Readback",
    passed:
      expectedDiscounts.length === 4 &&
      exactReadbacks === expectedDiscounts.length,
    durationMs: Date.now() - queryStart,
    details: {
      expectedCount: expectedDiscounts.length,
      exactReadbackCount: exactReadbacks,
    },
    provenance: shopifyProvenance,
  });

  // Check 4.6: Cleanup & Deactivation / Deletion
  const cleanStart = Date.now();
  if (options.cleanup === false) {
    checks.push(
      skippedCheck(
        "Discount Cleanup (Deactivate & Delete)",
        "Cleanup was disabled; validation discounts may remain in the test store",
      ),
    );
  } else
    try {
      let confirmedCleanedCount = 0;
      for (const [gid, expected] of cleanupAuthorities) {
        let exactOwnershipStillPresent = false;
        try {
          const remote = await lookupExpectedValidationDiscount(
            targetDomain,
            accessToken,
            expected,
            options.customFetch,
          );
          exactOwnershipStillPresent = Boolean(
            remote?.id === gid &&
              matchesExpectedValidationDiscount(remote, expected, {
                requireActive: false,
              }),
          );
        } catch {
          // Never mutate without a fresh exact marker/configuration readback.
        }

        if (exactOwnershipStillPresent) {
          try {
            await deactivateDiscount(
              targetDomain,
              accessToken,
              gid,
              options.customFetch,
            );
          } catch {
            // Deactivation may have committed before a response was lost.
          }
          try {
            await deleteDiscount(
              targetDomain,
              accessToken,
              gid,
              options.customFetch,
            );
          } catch {
            // A false/throw result can still represent an unknown committed
            // delete. Only exact node(id) absence below proves removal.
          }
        }
        try {
          const exactNode = await lookupValidationDiscountNodeById(
            targetDomain,
            accessToken,
            gid,
            options.customFetch,
          );
          if (exactNode === null) {
            confirmedCleanedCount += 1;
          }
        } catch {
          // Fail closed for this exact identity while continuing to verify the
          // remaining independently authorized fixture identities.
        }
      }
      const unresolvedDispatchedCount = dispatchedCreates.filter(
        (attempt) => attempt.dispatched && !attempt.resolvedGid,
      ).length;
      const cleanupSuccess =
        confirmedCleanedCount === cleanupAuthorities.size &&
        unresolvedDispatchedCount === 0;

      checks.push({
        name: "Discount Cleanup (Deactivate & Delete)",
        passed: cleanupSuccess,
        durationMs: Date.now() - cleanStart,
        details: {
          authorizedCleanupCount: cleanupAuthorities.size,
          confirmedCleanedCount,
          unresolvedDispatchedCount,
        },
        provenance: shopifyProvenance,
      });
    } catch {
      checks.push({
        name: "Discount Cleanup (Deactivate & Delete)",
        passed: false,
        durationMs: Date.now() - cleanStart,
        error: "Unable to prove exact validation discount cleanup",
        provenance: shopifyProvenance,
      });
    }

  const phasePassed = checks.every((c) => c.passed || c.skipped);
  return finalizePhase(
    {
      phase: "Shopify GraphQL Admin API 2026-07 Discount Lifecycle",
      passed: phasePassed,
      durationMs: Date.now() - startTime,
      checks,
    },
    shopifyProvenance,
  );
}

// ============================================================================
// Phase 5: Webhook Auto-Provisioning & Reconciliation
// ============================================================================

export async function validateWebhookProvisioningPhase(
  targetDomain: string,
  accessToken: string,
  options: {
    dryRun?: boolean;
    webhookSecret?: string;
    executionMode?: ValidationExecutionMode;
  } = {},
): Promise<ValidationPhaseResult> {
  const startTime = Date.now();
  const checks: ValidationCheckResult[] = [];
  const executionMode =
    options.executionMode || (options.dryRun ? "dry-run" : "live-admin");
  const provisioningProvenance = evidenceProvenance(
    options.dryRun
      ? "not-executed"
      : executionMode === "mock"
        ? "mocked-shopify-adapter"
        : "shopify-admin-api",
    executionMode,
  );
  const localProvenance = evidenceProvenance("local-static", executionMode);
  const webhookSecret = (
    options.webhookSecret ||
    process.env.SHOPIFY_WEBHOOK_SECRET ||
    ""
  ).trim();
  if (!webhookSecret) {
    return failedPhase(
      "Webhook Provisioning & Local Body-HMAC Checks",
      "Explicit Webhook Secret Availability",
      "SHOPIFY_WEBHOOK_SECRET or an explicit webhookSecret is required",
      localProvenance,
    );
  }

  // Check 5.1: 14 Canonical Topics Provisioning
  const provStart = Date.now();
  try {
    if (options.dryRun) {
      checks.push({
        ...skippedCheck(
          "Automated 14-Topic Webhook Provisioning & Idempotency",
          "Dry-run mode does not register Shopify webhooks",
        ),
        provenance: provisioningProvenance,
      });
    } else {
      const provResult = await ensureShopifyWebhooksRegistered({
        shopDomain: targetDomain,
        accessToken,
      });

      const passed =
        provResult.success ||
        provResult.registered.length + provResult.skipped.length ===
          SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length;

      checks.push({
        name: "Automated 14-Topic Webhook Provisioning & Idempotency",
        passed,
        durationMs: Date.now() - provStart,
        details: {
          registered: provResult.registered,
          skipped: provResult.skipped,
          failed: provResult.failed,
        },
        provenance: provisioningProvenance,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "Automated 14-Topic Webhook Provisioning & Idempotency",
      passed: false,
      durationMs: Date.now() - provStart,
      error: err.message || String(err),
      provenance: provisioningProvenance,
    });
  }

  // Check 5.2: Inbound Webhook HMAC Signature Verification
  const sigStart = Date.now();
  try {
    const rawPayload = JSON.stringify({
      id: 99887766,
      name: "#1001",
      total_price: "150.00",
      customer: { id: 12345 },
    });

    const validHmac = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawPayload, "utf8")
      .digest("base64");

    const isVerified = verifyShopifyWebhookSignature({
      body: rawPayload,
      signature: validHmac,
      secret: webhookSecret,
    });

    const isTamperRejected = !verifyShopifyWebhookSignature({
      body: rawPayload,
      signature: "invalid_tampered_signature==",
      secret: webhookSecret,
    });

    checks.push({
      name: "Local Webhook Body-HMAC Primitive & Tamper Check",
      passed: isVerified && isTamperRejected,
      durationMs: Date.now() - sigStart,
      provenance: localProvenance,
    });
  } catch (err: any) {
    checks.push({
      name: "Local Webhook Body-HMAC Primitive & Tamper Check",
      passed: false,
      durationMs: Date.now() - sigStart,
      error: err.message || String(err),
      provenance: localProvenance,
    });
  }

  const phasePassed = checks.every((c) => c.passed || c.skipped);
  return finalizePhase(
    {
      phase: "Webhook Provisioning & Local Body-HMAC Checks",
      passed: phasePassed,
      durationMs: Date.now() - startTime,
      checks,
    },
    evidenceProvenance("mixed", executionMode),
  );
}

// ============================================================================
// Main Validation Runner
// ============================================================================

export async function runTestStoreValidation(
  options: ValidationCLIOptions = {},
): Promise<TestStoreValidationReport> {
  const startTime = Date.now();
  const targetDomain = options.storeDomain || "n0pvef-cs.myshopify.com";
  const errors: Array<{ phase: string; check: string; error: string }> = [];
  const executionMode: ValidationExecutionMode = options.dryRun
    ? "dry-run"
    : options.mockShopify
      ? "mock"
      : "live-admin";

  // Phase 1: Domain Resolution
  const domainRes = await validateDomainResolution(targetDomain, {
    ...options,
    executionMode,
  });
  for (const c of domainRes.checks) {
    if (!c.passed && c.error)
      errors.push({ phase: domainRes.phase, check: c.name, error: c.error });
  }

  // Phase 2: local service-HMAC primitive and verifier checks
  const hmacRes = await validateLocalServiceHmacChecks(
    targetDomain,
    options.serviceSecret,
    executionMode,
  );
  for (const c of hmacRes.checks) {
    if (!c.passed && c.error)
      errors.push({ phase: hmacRes.phase, check: c.name, error: c.error });
  }

  // Phase 3: static claim-shape parser checks (not live JWT verification)
  const claimsRes = await validateStaticCustomerAccountClaimChecks(
    targetDomain,
    executionMode,
  );
  for (const c of claimsRes.checks) {
    if (!c.passed && c.error)
      errors.push({ phase: claimsRes.phase, check: c.name, error: c.error });
  }

  const requiresLiveCredentials =
    !options.dryRun &&
    (!options.skipDiscounts || (!options.skipWebhooks && !options.mockShopify));
  let accessToken: string | null = null;
  let credentialError: string | null = null;

  if (requiresLiveCredentials) {
    if (options.mockShopify) {
      if (!options.customFetch) {
        credentialError =
          "Mock Shopify mode requires an explicit customFetch implementation";
      } else {
        accessToken = "shopify_mock_transport_token";
      }
    } else {
      try {
        const credentials = await resolveShopifyOfflineCredentials({
          shopDomain: targetDomain,
        });
        accessToken = credentials.accessToken;
      } catch (error) {
        credentialError =
          error instanceof Error
            ? error.message
            : "Unable to resolve Shopify offline credentials";
      }
    }
  }

  // Phase 4: Shopify Discounts
  let discountsRes: ValidationPhaseResult;
  if (options.skipDiscounts) {
    discountsRes = skippedPhase(
      "Shopify GraphQL Admin API 2026-07 Discount Lifecycle",
      ["Discount lifecycle validation"],
      "Discount validation was skipped via flag",
      executionMode,
    );
  } else if (credentialError && !options.dryRun) {
    discountsRes = failedPhase(
      "Shopify GraphQL Admin API 2026-07 Discount Lifecycle",
      "Shopify Offline Credential Resolution",
      credentialError,
      evidenceProvenance("persisted-database", executionMode),
    );
  } else {
    discountsRes = await validateShopifyDiscountsLifecycle(
      targetDomain,
      accessToken || "",
      {
        dryRun: options.dryRun,
        cleanup: options.cleanup !== false,
        customFetch: options.customFetch,
        executionMode,
      },
    );
  }
  for (const c of discountsRes.checks) {
    if (!c.passed && c.error)
      errors.push({ phase: discountsRes.phase, check: c.name, error: c.error });
  }

  // Phase 5: Webhooks
  let webhooksRes: ValidationPhaseResult;
  if (options.skipWebhooks) {
    webhooksRes = skippedPhase(
      "Webhook Provisioning & Local Body-HMAC Checks",
      ["Webhook provisioning validation"],
      "Webhook validation was skipped via flag",
      executionMode,
    );
  } else if (credentialError && !options.dryRun && !options.mockShopify) {
    webhooksRes = failedPhase(
      "Webhook Provisioning & Local Body-HMAC Checks",
      "Shopify Offline Credential Resolution",
      credentialError,
      evidenceProvenance("persisted-database", executionMode),
    );
  } else {
    webhooksRes = await validateWebhookProvisioningPhase(
      targetDomain,
      accessToken || "",
      {
        dryRun: options.dryRun || options.mockShopify,
        webhookSecret: options.webhookSecret,
        executionMode,
      },
    );
  }
  for (const c of webhooksRes.checks) {
    if (!c.passed && c.error)
      errors.push({ phase: webhooksRes.phase, check: c.name, error: c.error });
  }

  const allPhases = [domainRes, hmacRes, claimsRes, discountsRes, webhooksRes];
  const allChecks = allPhases.flatMap((p) => p.checks);
  const passedCount = allChecks.filter((c) => c.passed && !c.skipped).length;
  const skippedCount = allChecks.filter((c) => c.skipped).length;
  const failedCount = allChecks.filter((c) => !c.passed && !c.skipped).length;

  const overallStatus =
    failedCount > 0 ? "FAILED" : skippedCount > 0 ? "WARNING" : "PASSED";

  const report: TestStoreValidationReport = {
    timestamp: new Date().toISOString(),
    storeDomain: targetDomain,
    executionMode,
    environment: options.dryRun
      ? "dry-run"
      : options.mockShopify
        ? "mock"
        : process.env.NODE_ENV || "test",
    overallStatus,
    totalDurationMs: Date.now() - startTime,
    summary: {
      totalChecks: allChecks.length,
      passedChecks: passedCount,
      failedChecks: failedCount,
      skippedChecks: skippedCount,
    },
    phases: {
      domainResolution: domainRes,
      localServiceHmacChecks: hmacRes,
      staticCustomerAccountClaimChecks: claimsRes,
      graphqlDiscounts: discountsRes,
      webhookProvisioning: webhooksRes,
    },
    errors,
  };

  if (options.outputReportPath) {
    try {
      const dir = path.dirname(options.outputReportPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        options.outputReportPath,
        JSON.stringify(report, null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn("Failed to write report file:", e);
    }
  }

  return report;
}

// ============================================================================
// CLI Handler
// ============================================================================

if (process.argv[1] && process.argv[1].includes("validate-test-store")) {
  const args = process.argv.slice(2);
  const storeArg = args.find((a) => a.startsWith("--store="))?.split("=")[1];
  const reportArg = args
    .find((a) => a.startsWith("--report="))
    ?.slice("--report=".length);
  const dryRun = args.includes("--dry-run");
  const mockShopify = args.includes("--mock-shopify");
  const jsonOutput = args.includes("--json");

  runTestStoreValidation({
    storeDomain: storeArg || "n0pvef-cs.myshopify.com",
    dryRun,
    mockShopify,
    outputReportPath: reportArg,
  }).then((report) => {
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        "==================================================================",
      );
      console.log(
        `WELETIC TEST STORE VALIDATION REPORT: ${report.storeDomain}`,
      );
      console.log(
        `Status: ${report.overallStatus} | Checks: ${report.summary.passedChecks}/${report.summary.totalChecks} Passed | Duration: ${report.totalDurationMs}ms`,
      );
      console.log(
        "==================================================================",
      );
    }
    process.exit(report.overallStatus === "FAILED" ? 1 : 0);
  });
}
