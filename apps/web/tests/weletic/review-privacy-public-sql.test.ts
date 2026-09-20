import { buildReviewPublicPrivacySql } from "@/lib/weletic/reviews/privacy-public-sql";
import { describe, expect, it } from "vitest";

const key = { identityKeyId: "fixture", secret: Buffer.alloc(32, 7) };
const input = {
  storeId: "store-'private",
  productId: "product-private",
  installationGeneration: "g1",
  keyring: { current: key, all: [key] },
};

describe("shared review SQL privacy fragments", () => {
  it("parameterizes scope and private readiness proof with fixed aliases", () => {
    const sql = buildReviewPublicPrivacySql(input);
    expect(sql.from.sql).toBe("WeleticProductReview r");
    expect(sql.eligible.sql).not.toContain(input.storeId);
    expect(sql.eligible.values).toContain(input.storeId);
    expect(sql.eligible.values).toContain(input.productId);
    expect(sql.eligible.values).toContain("g1");
    expect(sql.eligible.sql).toContain("t.customerDigest = i.customerDigest");
    expect(sql.eligible.sql).not.toContain("expiresAt");
  });
  it("distinguishes missing coverage from authoritative suppression", () => {
    const sql = buildReviewPublicPrivacySql(input);
    expect(sql.unknown.sql).toContain("AND NOT (EXISTS");
    expect(sql.unknown.sql).toContain("c.state = 'redacted'");
    expect(sql.eligible.sql).toContain("c.identityCount = (SELECT COUNT(*)");
    expect(sql.eligible.sql).toContain("i.identityKind = 'customer_email'");
    expect(sql.eligible.sql).toContain("st.storeAccessState = 'active'");
  });
  it("fails closed for absent generation or incomplete keyring", () => {
    expect(() =>
      buildReviewPublicPrivacySql({ ...input, installationGeneration: "" }),
    ).toThrow();
    expect(() =>
      buildReviewPublicPrivacySql({
        ...input,
        keyring: { current: key, all: [] },
      }),
    ).toThrow();
  });
});
