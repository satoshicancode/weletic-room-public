import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRetainedEnvironment } from "./init.mjs";
import { planShopperRewardExpansion } from "./shopper-reward-migration-plan.mjs";
import { isLocalServiceTarget, privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/web/package.json"));
let db;
let stage = "arguments";
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    ![
      "--confirm-isolated-expand-schema",
      "--inspect-isolated-review-claims",
      "--confirm-isolated-review-claims",
      "--confirm-isolated-shopper-coupon-outbox",
      "--confirm-isolated-complete-expansion",
      "--confirm-isolated-coupon-use",
      "--confirm-isolated-coupon-retention-index",
      "--confirm-isolated-review-invalidation",
      "--confirm-isolated-invalidation-reward-status",
    ].includes(args[0]) ||
    args[1] !== "--credentials-root"
  )
    throw new Error();
  const source = resolve(args[2]);
  stage = "credentials";
  if (
    hasRetainedEnvironment(root) ||
    hasRetainedEnvironment(source) ||
    !privateCredentialFiles(source)
  )
    throw new Error();
  const fd = openSync(
    join(source, "apps/web/.env.loyalty.local"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let config;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error();
    config = createRequire(require.resolve("dotenv-flow"))("dotenv").parse(
      readFileSync(fd),
    );
  } finally {
    closeSync(fd);
  }
  if (!isLocalServiceTarget(config)) throw new Error();
  const url = new URL(config.DATABASE_URL);
  if (
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_dev"
  )
    throw new Error();
  stage = "docker-ownership";
  const [container] = JSON.parse(
    execFileSync("docker", ["inspect", "weletic-loyalty-dev-mysql-1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const ports = container.NetworkSettings.Ports["3306/tcp"];
  if (
    container.State.Status !== "running" ||
    container.Config.Labels["com.docker.compose.project"] !==
      "weletic-loyalty-dev" ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== "3307"
  )
    throw new Error();
  const { PrismaClient } = require("@prisma/client");
  db = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  stage = "database-identity";
  const [identity] =
    await db.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`;
  if (
    identity.name !== "weletic_loyalty_dev" ||
    identity.principal !== "loyalty_dev@%"
  )
    throw new Error();
  const cleanEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const diff = () =>
    execFileSync(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-schema-datasource",
        "./prisma/schema",
        "--to-schema-datamodel",
        "./prisma/schema",
        "--script",
      ],
      {
        cwd: join(root, "apps/web"),
        env: { ...cleanEnv, DATABASE_URL: config.DATABASE_URL },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    ).trim();
  const actual = diff();
  if (args[0] === "--inspect-isolated-review-claims") {
    console.log(actual);
  } else {
    const complete = args[0] === "--confirm-isolated-complete-expansion";
    const invalidation =
      complete || args[0] === "--confirm-isolated-review-invalidation";
    const invalidationRewardStatus =
      invalidation ||
      args[0] === "--confirm-isolated-invalidation-reward-status";
    const reviewClaims =
      complete || args[0] === "--confirm-isolated-review-claims";
    const couponOutbox =
      complete || args[0] === "--confirm-isolated-shopper-coupon-outbox";
    const couponUse = complete || args[0] === "--confirm-isolated-coupon-use";
    const retentionIndex =
      complete ||
      couponUse ||
      args[0] === "--confirm-isolated-coupon-retention-index";
    const files = complete
      ? [
          "shopper_reward_ownership",
          "review_incentive_claims",
          "shopper_coupon_outbox",
          "reward_coupon_use",
          "review_invalidation",
          "review_invalidation_reward_status",
        ]
      : args[0] === "--confirm-isolated-invalidation-reward-status"
        ? ["review_invalidation_reward_status"]
        : invalidation
          ? ["review_invalidation", "review_invalidation_reward_status"]
          : couponUse
            ? ["reward_coupon_use"]
            : retentionIndex
              ? ["reward_coupon_use_retention_index"]
              : [
                  couponOutbox
                    ? "shopper_coupon_outbox"
                    : reviewClaims
                      ? "review_incentive_claims"
                      : "shopper_reward_ownership",
                ];
    const reviewedSql = files.map((name) =>
      readFileSync(
        join(root, `infra/shopify-development/migrations/20260907_${name}.sql`),
        "utf8",
      ).trim(),
    );
    const empty = (sql) =>
      sql === "" || sql === "-- This is an empty migration.";
    stage = "exact-expand-diff";
    const before = await db.weleticRewardRedemption.count();
    const outboxBefore = couponOutbox
      ? await db.weleticLoyaltyOutboxJob.count()
      : null;
    const reviewCounts = reviewClaims
      ? await Promise.all([
          db.weleticReviewSettings.count(),
          db.weleticReviewRequest.count(),
          db.weleticProductReview.count(),
        ])
      : null;
    let applied = false;
    if (!empty(actual)) {
      const statements = planShopperRewardExpansion(actual, reviewedSql);
      stage = "expand-isolated-reward-table";
      // MySQL DDL is not transactional. Stop on a partial failure; never drop or
      // rebuild the table to recover, and do not silently retry an altered diff.
      for (const sql of statements) await db.$executeRawUnsafe(sql);
      applied = true;
    }
    stage = "post-stage-validation";
    if (!empty(diff()) || (await db.weleticRewardRedemption.count()) !== before)
      throw new Error();
    if (
      outboxBefore !== null &&
      (await db.weleticLoyaltyOutboxJob.count()) !== outboxBefore
    )
      throw new Error();
    if (
      reviewCounts &&
      JSON.stringify(reviewCounts) !==
        JSON.stringify(
          await Promise.all([
            db.weleticReviewSettings.count(),
            db.weleticReviewRequest.count(),
            db.weleticProductReview.count(),
          ]),
        )
    )
      throw new Error();
    console.log(
      JSON.stringify({
        status: applied
          ? invalidationRewardStatus && !invalidation
            ? "isolated_review_invalidation_reward_status_expanded"
            : invalidation && !complete
              ? "isolated_review_invalidation_expanded"
              : retentionIndex && !couponUse && !complete
                ? "isolated_coupon_retention_index_expanded"
                : complete
                  ? "isolated_incentive_foundation_expanded"
                  : couponUse
                    ? "isolated_coupon_use_expanded"
                    : couponOutbox
                      ? "isolated_shopper_coupon_outbox_expanded"
                      : reviewClaims
                        ? "isolated_review_claims_expanded"
                        : "isolated_reward_ownership_expanded"
          : "isolated_schema_already_matches",
        couponUseExpansion: couponUse,
        reviewInvalidationExpansion: invalidation,
        reviewInvalidationRewardStatusExpansion: invalidationRewardStatus,
        couponRetentionIndexExpansion: retentionIndex,
        historicalRowsRewritten: 0,
        sharedEnvironmentApplied: false,
        directIssuanceEnabled: false,
      }),
    );
  }
} catch {
  console.error(
    `Reward ownership staging refused or failed at ${stage}. No destructive retry or credential output.`,
  );
  process.exitCode = 1;
} finally {
  if (db) await db.$disconnect();
}
