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
import { isLocalServiceTarget, privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/web/package.json"));
let db;
let stage = "arguments";
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== "--confirm-isolated-additive-schema" ||
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
  function diff() {
    return execFileSync(
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
  }
  stage = "exact-additive-diff";
  const expected = readFileSync(
    join(
      root,
      "infra/shopify-development/migrations/20260906_merchant_settings.sql",
    ),
    "utf8",
  ).trim();
  const actual = diff();
  const empty = (value) =>
    value === "-- This is an empty migration." || value === "";
  let created = false;
  if (!empty(actual)) {
    if (
      actual !== expected ||
      !/^-- CreateTable\nCREATE TABLE `WeleticMerchantSettings` \(/.test(
        expected,
      ) ||
      (expected.match(/;/g) ?? []).length !== 1
    )
      throw new Error();
    stage = "create-isolated-table";
    await db.$executeRawUnsafe(expected);
    created = true;
  }
  stage = "post-stage-diff";
  if (!empty(diff())) throw new Error();
  console.log(
    JSON.stringify({
      status: created
        ? "isolated_settings_table_staged"
        : "isolated_schema_already_matches",
      table: "WeleticMerchantSettings",
      existingTablesChanged: 0,
      merchantRowsWritten: 0,
      sharedEnvironmentApplied: false,
    }),
  );
} catch {
  console.error(
    `Settings schema staging refused or failed at ${stage}. No destructive retry or credential output.`,
  );
  process.exitCode = 1;
} finally {
  if (db) await db.$disconnect();
}
