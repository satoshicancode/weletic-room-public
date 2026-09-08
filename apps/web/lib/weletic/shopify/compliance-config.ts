const TEST_DEFAULTS = {
  customerTombstoneRetentionDays: 3_650,
  financialRetentionDays: 2_555,
  exportRetentionHours: 24,
} as const;

function readRequiredBoundedInteger({
  name,
  rawValue,
  testDefault,
  maximum,
}: {
  name: string;
  rawValue: string | undefined;
  testDefault: number;
  maximum: number;
}) {
  const value = rawValue?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "test") return testDefault;
    throw new Error(`${name} is required for Shopify compliance processing.`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

export function getShopifyCustomerTombstoneRetentionDays(
  rawValue = process.env.WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS,
) {
  return readRequiredBoundedInteger({
    name: "WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS",
    rawValue,
    testDefault: TEST_DEFAULTS.customerTombstoneRetentionDays,
    maximum: 36_500,
  });
}

export function getShopifyFinancialRetentionDays(
  rawValue = process.env.WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS,
) {
  return readRequiredBoundedInteger({
    name: "WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS",
    rawValue,
    testDefault: TEST_DEFAULTS.financialRetentionDays,
    maximum: 36_500,
  });
}

export function getShopifyComplianceExportRetentionHours(
  rawValue = process.env.WELETIC_SHOPIFY_COMPLIANCE_EXPORT_RETENTION_HOURS,
) {
  return readRequiredBoundedInteger({
    name: "WELETIC_SHOPIFY_COMPLIANCE_EXPORT_RETENTION_HOURS",
    rawValue,
    testDefault: TEST_DEFAULTS.exportRetentionHours,
    maximum: 8_760,
  });
}

export function addRetentionDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function addRetentionHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1_000);
}
