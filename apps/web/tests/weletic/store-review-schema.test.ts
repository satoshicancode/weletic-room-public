import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../infra/shopify-development/migrations/20260922_store_review_core.sql",
  ),
  "utf8",
);
const statements = (sql: string) =>
  sql.match(/CREATE TABLE `WeleticStoreReview[^`]*`[\s\S]*?;/g) ?? [];
const expectedTables = [
  "WeleticStoreReviewSettings",
  "WeleticStoreReviewRequest",
  "WeleticStoreReviewRequestLine",
  "WeleticStoreReview",
  "WeleticStoreReviewModerationAudit",
];

describe("draft store-review additive schema (no database connection)", () => {
  it("matches Prisma's generated DDL without changing historical tables", () => {
    const require = createRequire(import.meta.url);
    const generated = execFileSync(
      process.execPath,
      [
        resolve(
          dirname(require.resolve("prisma/package.json")),
          "build/index.js",
        ),
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema-datamodel",
        "prisma/schema",
        "--script",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          DATABASE_URL: "mysql://schema:check@127.0.0.1:1/schema_only",
        },
      },
    );
    expect(statements(generated)).toHaveLength(5);
    expect(statements(migration)).toEqual(statements(generated));
    const executable = migration.replace(/^--.*$/gm, "");
    expect(executable).not.toMatch(
      /\b(?:ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i,
    );
    expect(
      [...executable.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    ).toEqual(expectedTables);
  }, 30_000);
  it("starts with collection and sending disabled and no fabricated verification or reward", () => {
    expect(migration).toContain("`enabled` BOOLEAN NOT NULL DEFAULT false");
    expect(migration).toContain(
      "`requestEmailEnabled` BOOLEAN NOT NULL DEFAULT false",
    );
    expect(migration).toContain(
      "`verifiedPurchase` BOOLEAN NOT NULL DEFAULT false",
    );
    expect(migration).toContain(
      "`incentivized` BOOLEAN NOT NULL DEFAULT false",
    );
    expect(migration).toContain("DEFAULT 'ineligible'");
  });
  it("binds a single invitation to each order and preserves moderation revisions", () => {
    expect(migration).toContain(
      "UNIQUE INDEX `WeleticStoreReviewRequest_storeId_orderId_key`(`storeId`, `orderId`)",
    );
    expect(migration).toContain(
      "UNIQUE INDEX `WeleticStoreReview_requestId_key`(`requestId`)",
    );
    expect(migration).toContain(
      "UNIQUE INDEX `store_review_moderation_version`(`storeId`, `reviewId`, `toVersion`)",
    );
    expect(migration).not.toContain(
      "CREATE TABLE `WeleticStoreReviewIncentiveClaim`",
    );
  });
});
