import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseName, hasRetainedEnvironment } from "./init.mjs";
import { isLocalServiceTarget, privateCredentialFiles } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(root, "apps/web");
const require = createRequire(join(webRoot, "package.json"));
const { parse } = require("dotenv-flow");
const { PrismaClient } = require("@prisma/client");
const cleanEnvironment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const table = "WeleticShopifySessionCoordination";
let client;

try {
  const mode = process.argv.slice(2).join(" ");
  if (
    ![
      "",
      "--apply-isolated-migration",
      "--test-isolated-coordination",
      "--verify-isolated-schema",
      "--initialize-session-privacy",
    ].includes(mode) ||
    hasRetainedEnvironment(root) ||
    !privateCredentialFiles(root)
  )
    throw new Error("Unsafe invocation");
  const web = parse(join(webRoot, ".env.loyalty.local"));
  if (!isLocalServiceTarget(web)) throw new Error("Unsafe target");
  const [container] = JSON.parse(
    execFileSync("docker", ["inspect", "weletic-loyalty-dev-mysql-1"], {
      env: cleanEnvironment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const bindings = container.NetworkSettings.Ports["3306/tcp"];
  if (
    container.Config.Labels["com.docker.compose.project"] !==
      "weletic-loyalty-dev" ||
    container.Config.Labels["com.docker.compose.service"] !== "mysql" ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    bindings[0].HostPort !== "3307" ||
    !container.Mounts.some(
      (mount) =>
        mount.Destination === "/var/lib/mysql" &&
        mount.Type === "volume" &&
        mount.Name.startsWith("weletic-loyalty-dev_"),
    )
  )
    throw new Error("Unexpected database ownership");
  client = new PrismaClient({ datasources: { db: { url: web.DATABASE_URL } } });
  const [identity] =
    await client.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`;
  if (
    identity.name !== databaseName ||
    identity.principal !== "loyalty_dev@%"
  ) {
    throw new Error("Unexpected database identity");
  }
  const tables = await client.$queryRaw`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${databaseName}
  `;
  const existing = tables.some(({ name }) => name === table);
  if (mode === "--initialize-session-privacy") {
    const [initializationLock] =
      await client.$queryRaw`SELECT GET_LOCK('weletic-loyalty-dev-session-privacy-init', 0) AS acquired`;
    if (Number(initializationLock.acquired) !== 1)
      throw new Error("Concurrent privacy initialization refused");
    // This is an additive first initialization, never a key rotation. Existing
    // persisted identities require their original key and a separate recovery.
    if (!existing || tables.length !== 142)
      throw new Error("Unexpected schema baseline");
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name))
        throw new Error("Unexpected table identifier");
      const [count] = await client.$queryRawUnsafe(
        `SELECT COUNT(*) AS n FROM \`${name}\``,
      );
      if (BigInt(count.n) !== 0n)
        throw new Error(
          "Privacy initialization requires an empty isolated database",
        );
    }
    const descriptor = openSync(
      join(webRoot, ".env.loyalty.local"),
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const metadata = fstatSync(descriptor);
      const contents = readFileSync(descriptor, "utf8");
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o777) !== 0o600 ||
        contents.includes("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS")
      )
        throw new Error("Refusing existing or unsafe privacy configuration");
      writeSync(
        descriptor,
        `\nWELETIC_SHOPIFY_PRIVACY_HMAC_KEYS=loyalty-dev-v1:${randomBytes(32).toString("base64")}\n`,
      );
    } finally {
      closeSync(descriptor);
    }
    console.log(
      JSON.stringify({
        status: "isolated_session_privacy_initialized",
        rotated: false,
        appInstalled: false,
      }),
    );
  } else if (mode === "--apply-isolated-migration") {
    if (existing || tables.length !== 141)
      throw new Error("Unexpected schema baseline");
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name))
        throw new Error("Unexpected table identifier");
      const [count] = await client.$queryRawUnsafe(
        `SELECT COUNT(*) AS n FROM \`${name}\``,
      );
      if (BigInt(count.n) !== 0n) throw new Error("Database contains data");
    }
    const sql = readFileSync(
      join(
        webRoot,
        "scripts/loyalty/sql/shopify-session-coordination-stage-1.sql",
      ),
      "utf8",
    );
    // This checked-in, single CREATE TABLE migration is the only accepted write.
    await client.$executeRawUnsafe(sql);
    console.log(
      JSON.stringify({
        status: "isolated_coordination_table_created",
        appInstalled: false,
      }),
    );
  } else if (mode === "--verify-isolated-schema") {
    if (!existing) throw new Error("Additive schema is not staged");
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
        "--exit-code",
      ],
      {
        cwd: webRoot,
        env: { ...cleanEnvironment, DATABASE_URL: web.DATABASE_URL },
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    console.log(
      JSON.stringify({
        status: "isolated_schema_matches_prisma",
        changed: false,
      }),
    );
  } else if (mode === "--test-isolated-coordination") {
    if (!existing) throw new Error("Additive schema is not staged");
    const output = execFileSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.shopify-session-db.config.ts",
      ],
      {
        cwd: webRoot,
        env: {
          ...cleanEnvironment,
          DATABASE_URL: web.DATABASE_URL,
          SHOPIFY_SESSION_DATABASE_INTEGRATION: "1",
        },
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Forward only success summary lines. Failure diagnostics may contain URLs.
    for (const line of output.split("\n")) {
      if (/Test Files|Tests\s/.test(line)) console.log(line);
    }
    console.log(
      JSON.stringify({
        status: "isolated_coordination_tests_passed",
        appInstalled: false,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        status: "isolated_coordination_audit",
        tablePresent: existing,
        tableCount: tables.length,
        changed: false,
      }),
    );
  }
} catch {
  console.error(
    "Isolated session coordination command refused or failed; no automatic repair or retry was attempted.",
  );
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
