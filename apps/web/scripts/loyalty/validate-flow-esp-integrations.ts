import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHOPIFY_FLOW_MAX_PAYLOAD_BYTES,
  SHOPIFY_FLOW_TRIGGER_HANDLES,
  validateAndNormalizeFlowPayload,
} from "../../lib/weletic/loyalty/flow-triggers";
import { FlowTriggerPayloadSchema } from "../../lib/weletic/loyalty/outbox";

type Check = { name: string; passed: boolean; detail?: string };

const shopifyAppRoot = resolve(process.cwd(), "../../packages/shopify-app");
const manifestPath = (directory: string) =>
  resolve(shopifyAppRoot, "extensions", directory, "shopify.extension.toml");

function readManifest(directory: string) {
  return readFileSync(manifestPath(directory), "utf8");
}

function checkManifest({
  directory,
  handle,
  fields,
}: {
  directory: string;
  handle: string;
  fields: string[];
}): Check {
  try {
    const manifest = readManifest(directory);
    const passed =
      manifest.includes('type = "flow_trigger"') &&
      manifest.includes(`handle = "${handle}"`) &&
      manifest.includes('type = "customer_reference"') &&
      fields.every((field) => manifest.includes(`key = "${field}"`));
    return {
      name: `Flow manifest ${handle}`,
      passed,
      detail: passed
        ? undefined
        : "Manifest contract does not match runtime payload keys.",
    };
  } catch (error) {
    return {
      name: `Flow manifest ${handle}`,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runFlowIntegrationValidation() {
  const checks: Check[] = [
    checkManifest({
      directory: "weletic-points-earned",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
      fields: ["Points delta", "Points balance", "Reason", "Order id"],
    }),
    checkManifest({
      directory: "weletic-vip-tier-changed",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED,
      fields: ["Previous tier", "New tier", "Multiplier"],
    }),
    checkManifest({
      directory: "weletic-reward-redeemed",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED,
      fields: ["Reward type", "Discount code", "Points spent"],
    }),
    checkManifest({
      directory: "weletic-points-expiring-soon",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
      fields: ["Points expiring", "Expiry date", "Urgency"],
    }),
  ];

  const lifecycleManifest = readManifest("weletic-flow-lifecycle");
  checks.push({
    name: "Flow lifecycle callback manifest",
    passed:
      lifecycleManifest.includes('type = "flow_trigger_lifecycle_callback"') &&
      lifecycleManifest.includes(
        'url = "https://app.weletic.com/api/shopify/flow/lifecycle"',
      ),
  });

  const samplePayloads = [
    validateAndNormalizeFlowPayload(
      SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
      {
        customerGid: "gid://shopify/Customer/12345",
        pointsDelta: BigInt("9007199254740993"),
        pointsBalance: BigInt("9007199254741093"),
        reason: "order_purchase",
        orderId: "order-1",
      },
    ),
    validateAndNormalizeFlowPayload(
      SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED,
      {
        customerGid: "12345",
        previousTier: "Silver",
        newTier: "Gold",
        multiplier: "1.5",
      },
    ),
    validateAndNormalizeFlowPayload(
      SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED,
      {
        customerGid: "12345",
        rewardType: "amount_off",
        discountCode: "REWARD-123",
        pointsSpent: "1000",
      },
    ),
    validateAndNormalizeFlowPayload(
      SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
      {
        customerGid: "12345",
        pointsExpiring: "500",
        expiryDate: "2026-12-01T00:00:00.000Z",
        urgency: "warning",
      },
    ),
  ];
  checks.push({
    name: "Runtime payloads use numeric customer references and remain below 50 KB",
    passed: samplePayloads.every(
      (payload) =>
        typeof payload.customer_id === "number" &&
        Buffer.byteLength(JSON.stringify(payload), "utf8") <
          SHOPIFY_FLOW_MAX_PAYLOAD_BYTES,
    ),
  });

  checks.push({
    name: "Durable outbox payload contract",
    passed: FlowTriggerPayloadSchema.safeParse({
      accountId: "wacc_validation",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
      pointsDelta: "10",
      pointsBalance: "20",
      reason: "validation",
    }).success,
  });

  const failedChecks = checks.filter(({ passed }) => !passed);
  return {
    version: 2,
    timestamp: new Date().toISOString(),
    overallStatus: failedChecks.length === 0 ? "PASSED" : "FAILED",
    executionMode: "local-static",
    provenance: {
      source: "production-contracts",
      live: false,
      stagingDeployment: "NOT_RUN_REQUIRES_EXPLICIT_APPROVAL",
      espDelivery: "DEFERRED",
    },
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.length - failedChecks.length,
      failedChecks: failedChecks.length,
    },
    checks,
  };
}

function main() {
  const unsupportedLive = process.argv.includes("--live");
  if (unsupportedLive) {
    console.log(
      JSON.stringify(
        {
          version: 2,
          overallStatus: "FAILED",
          executionMode: "live",
          error:
            "Live Flow validation is a separate staging deployment gate and cannot be simulated by this validator.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const report = runFlowIntegrationValidation();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.overallStatus === "PASSED" ? 0 : 1;
}

if (process.argv[1]?.includes("validate-flow-esp-integrations")) main();
