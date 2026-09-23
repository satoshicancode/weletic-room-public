import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditReviewReleaseSchema,
  REVIEW_RELEASE_MODELS,
  REVIEW_RELEASE_TABLES,
  type ReviewSchemaColumn,
  type ReviewSchemaIndex,
  type ReviewSchemaTable,
} from "../../lib/weletic/reviews/schema-preflight";

const files = [
  "20260920_review_collection_settings.sql",
  "20260922_store_review_core.sql",
  "20260923_shopper_delivery_budget.sql",
];
const normalizedType = (value: string) =>
  value
    .toLowerCase()
    .replace(/^boolean$/, "tinyint(1)")
    .replace(/^integer$/, "int")
    .replaceAll(", ", ",");
function defaultFromSql(rest: string) {
  const match = rest.match(/\bDEFAULT\s+(?:'([^']*)'|(false|true|\d+))/i);
  if (!match) return null;
  if (match[2]?.toLowerCase() === "false") return "0";
  if (match[2]?.toLowerCase() === "true") return "1";
  return match[1] ?? match[2] ?? null;
}

function migrationMetadata() {
  const tables: ReviewSchemaTable[] = REVIEW_RELEASE_TABLES.map(
    (tableName) => ({
      tableName,
      tableType: "BASE TABLE",
      engine: "InnoDB",
    }),
  );
  const columns: ReviewSchemaColumn[] = [];
  const indexes: ReviewSchemaIndex[] = [];
  for (const name of files) {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "../../infra/shopify-development/migrations",
        name,
      ),
      "utf8",
    );
    for (const match of sql.matchAll(
      /CREATE TABLE `([^`]+)` \(([\s\S]*?)\) DEFAULT CHARACTER SET/g,
    )) {
      const [, table, body] = match;
      for (const line of body.split("\n")) {
        const column = line.match(
          /^\s*`([^`]+)`\s+([A-Z]+(?:\([^)]*\))?)(.*)$/,
        );
        if (column)
          columns.push({
            tableName: table,
            columnName: column[1],
            columnType: normalizedType(column[2]),
            nullable: /\bNOT NULL\b/.test(column[3]) ? "NO" : "YES",
            defaultValue: defaultFromSql(column[3]),
          });
        const index = line.match(/^\s*(UNIQUE )?INDEX `([^`]+)`\s*\(([^)]+)\)/);
        const primary = line.match(/^\s*PRIMARY KEY \(([^)]+)\)/);
        if (index || primary) {
          const indexName = index?.[2] ?? "PRIMARY";
          const keyColumns = [
            ...(index?.[3] ?? primary?.[1] ?? "").matchAll(/`([^`]+)`/g),
          ].map((part) => part[1]);
          keyColumns.forEach((columnName, ordinal) =>
            indexes.push({
              tableName: table,
              indexName,
              columnName,
              nonUnique: index?.[1] || primary ? 0 : 1,
              sequence: ordinal + 1,
              prefixLength: null,
            }),
          );
        }
      }
    }
    for (const alter of sql.matchAll(/ALTER TABLE `([^`]+)`([\s\S]*?);/g)) {
      const table = alter[1];
      for (const column of alter[2].matchAll(
        /ADD COLUMN `([^`]+)` ([A-Z]+(?:\([^)]*\))?)([^,;]*)/g,
      ))
        columns.push({
          tableName: table,
          columnName: column[1],
          columnType: normalizedType(column[2]),
          nullable: /\bNOT NULL\b/.test(column[3]) ? "NO" : "YES",
          defaultValue: defaultFromSql(column[3]),
        });
      const jobType = alter[2].match(
        /MODIFY COLUMN `jobType` (ENUM\([^;]+\)) NOT NULL/,
      );
      if (jobType)
        columns.push({
          tableName: table,
          columnName: "jobType",
          columnType: jobType[1].replace(/^ENUM/, "enum").replaceAll(", ", ","),
          nullable: "NO",
          defaultValue: null,
        });
    }
  }
  const modelColumns: Record<string, string[]> = {};
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    if (!REVIEW_RELEASE_MODELS.some((name) => name === table)) continue;
    modelColumns[table] = model.fields
      .filter((field) => field.kind !== "object")
      .map((field) => field.dbName ?? field.name);
  }
  return { tables, columns, indexes, modelColumns };
}

describe("review release schema preflight", () => {
  it("accepts metadata derived from all three checked-in migrations and current Prisma models", () => {
    expect(auditReviewReleaseSchema(migrationMetadata())).toEqual({
      ready: true,
      issues: [],
    });
  });

  it("rejects a missing privacy table, altered private column and absent reminder export source", () => {
    const metadata = migrationMetadata();
    metadata.tables = metadata.tables.filter(
      (row) => row.tableName !== "WeleticStoreReviewModerationAudit",
    );
    metadata.columns = metadata.columns.filter(
      (row) =>
        !(
          row.tableName === "WeleticReviewReminder" &&
          row.columnName === "encryptedDeliverySnapshot"
        ),
    );
    const content = metadata.columns.find(
      (row) =>
        row.tableName === "WeleticStoreReview" && row.columnName === "body",
    );
    if (!content) throw new Error("Expected migration column missing");
    content.columnType = "varchar(191)";
    const result = auditReviewReleaseSchema(metadata);
    expect(result.ready).toBe(false);
    expect(result.issues).toContain(
      "table:WeleticStoreReviewModerationAudit:innodb_required",
    );
    expect(result.issues).toContain(
      "column:WeleticReviewReminder:encryptedDeliverySnapshot:missing",
    );
    expect(result.issues).toContain(
      "column:WeleticStoreReview:body:incompatible",
    );
  });

  it("rejects an altered outbox lineage and a weakened shared capacity index", () => {
    const metadata = migrationMetadata();
    const outbox = metadata.columns.find(
      (row) =>
        row.tableName === "WeleticLoyaltyOutboxJob" &&
        row.columnName === "jobType",
    );
    if (!outbox) throw new Error("Expected outbox enum missing");
    outbox.columnType = outbox.columnType.replace(
      ",'ANONYMOUS_REFERRAL_EMAIL'",
      "",
    );
    metadata.indexes = metadata.indexes.filter(
      (row) =>
        !(
          row.tableName === "WeleticShopperDeliveryIdentity" &&
          row.indexName === "wl_delivery_identity_lookup_idx"
        ),
    );
    const result = auditReviewReleaseSchema(metadata);
    expect(result.ready).toBe(false);
    expect(result.issues).toContain("outbox:jobType:unknown_lineage");
    expect(result.issues).toContain(
      "index:WeleticShopperDeliveryIdentity:storeId,identityKind,identityKeyId,customerDigest:missing_or_incompatible",
    );
  });

  it("rejects truncated review and email identity enums and enabled-by-default collection", () => {
    const metadata = migrationMetadata();
    const mutate = (tableName: string, columnName: string) => {
      const row = metadata.columns.find(
        (column) =>
          column.tableName === tableName && column.columnName === columnName,
      );
      if (!row) throw new Error("Expected migration column missing");
      return row;
    };
    mutate("WeleticStoreReviewRequest", "status").columnType =
      "enum('queued','sending','submitted')";
    mutate("WeleticStoreReview", "status").columnType =
      "enum('pending','published','hidden')";
    mutate("WeleticShopperDeliveryIdentity", "identityKind").columnType =
      "enum('customer_id')";
    mutate("WeleticStoreReviewSettings", "requestEmailEnabled").defaultValue =
      "1";
    const result = auditReviewReleaseSchema(metadata);
    expect(result.ready).toBe(false);
    for (const item of [
      "column:WeleticStoreReviewRequest:status:incompatible",
      "column:WeleticStoreReview:status:incompatible",
      "column:WeleticShopperDeliveryIdentity:identityKind:incompatible",
      "column:WeleticStoreReviewSettings:requestEmailEnabled:incompatible",
    ])
      expect(result.issues).toContain(item);
  });

  it("requires reminder discovery and moderation privacy indexes", () => {
    const metadata = migrationMetadata();
    metadata.indexes = metadata.indexes.filter(
      (row) =>
        ![
          "review_reminder_discovery",
          "store_review_moderation_privacy",
        ].includes(row.indexName),
    );
    const result = auditReviewReleaseSchema(metadata);
    expect(result.ready).toBe(false);
    expect(result.issues).toContain(
      "index:WeleticReviewReminder:status,updatedAt,id:missing_or_incompatible",
    );
    expect(result.issues).toContain(
      "index:WeleticStoreReviewModerationAudit:storeId,redactedAt,id:missing_or_incompatible",
    );
  });

  it("requires every index declared by the three new-table migrations", () => {
    const baseline = migrationMetadata();
    const keys = new Set(
      baseline.indexes.map((row) => `${row.tableName}\0${row.indexName}`),
    );
    for (const key of keys) {
      const [table, index] = key.split("\0");
      const metadata = migrationMetadata();
      metadata.indexes = metadata.indexes.filter(
        (row) => !(row.tableName === table && row.indexName === index),
      );
      expect(
        auditReviewReleaseSchema(metadata).ready,
        `${table}.${index}`,
      ).toBe(false);
    }
  });
});
