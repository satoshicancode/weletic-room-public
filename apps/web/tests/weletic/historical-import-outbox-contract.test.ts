import { describe, expect, it } from "vitest";
import { validateOutboxPayload } from "../../lib/weletic/loyalty/outbox";

describe.each([
  "HISTORICAL_IMPORT_COMMIT",
  "HISTORICAL_IMPORT_ROLLBACK",
] as const)("%s payload", (jobType) => {
  const payload = {
    sourceId: "wlimp_source",
    programId: "wprog_program",
    installationGeneration: "g1",
    sourceRevision: 1,
  };
  it("accepts bounded source-only execution evidence", () => {
    expect(() => validateOutboxPayload(jobType, payload)).not.toThrow();
  });
  it.each([
    { sourceId: "" },
    { programId: "x".repeat(192) },
    { installationGeneration: null },
    { installationGeneration: "" },
    { installationGeneration: "x".repeat(65) },
    { sourceRevision: -1 },
    { sourceRevision: 1.5 },
    { sourceRevision: 2147483648 },
    { leaseId: "private-lease" },
    { shopifyCustomerId: "gid://shopify/Customer/1" },
    { rawFile: "private-upload" },
  ])("rejects malformed, private or unbounded fields: %j", (override) => {
    expect(() =>
      validateOutboxPayload(jobType, { ...payload, ...override }),
    ).toThrow();
  });
});
