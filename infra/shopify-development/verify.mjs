import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buckets, databaseName, secretDirectory } from "./init.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/web/package.json"));
const { parse } = require("dotenv-flow");
const { connect } = require("@planetscale/database");
const { Redis } = require("@upstash/redis");
const { AwsClient } = require("aws4fetch");
const checks = [];
export function privateCredentialFiles(root) {
  try {
    const directory = join(root, secretDirectory);
    const stat = lstatSync(directory);
    return (
      stat.isDirectory() &&
      (stat.mode & 0o777) === 0o700 &&
      [
        ...[
          "mysql-root",
          "mysql-app",
          "redis-tokens.json",
          "s3-admin.json",
          "s3-config.json",
        ].map((name) => join(directory, name)),
        join(root, "apps/web/.env.loyalty.local"),
        join(root, "packages/shopify-app/.env.loyalty.local"),
      ].every((path) => {
        const file = lstatSync(path);
        return file.isFile() && (file.mode & 0o777) === 0o600;
      })
    );
  } catch {
    return false;
  }
}
export function exactDatabaseGrants(grants, partialRevokes) {
  const name = partialRevokes
    ? databaseName
    : databaseName.replaceAll("_", "\\_");
  const principal = "TO `loyalty_dev`@`%`";
  return (
    grants.length === 2 &&
    grants.includes(`GRANT USAGE ON *.* ${principal}`) &&
    grants.includes(`GRANT ALL PRIVILEGES ON \`${name}\`.* ${principal}`)
  );
}
export function publicReadPolicyMatches(value) {
  if (
    !value ||
    !Array.isArray(value.Statement) ||
    value.Statement.some(
      (statement) => !statement || typeof statement !== "object",
    )
  )
    return false;
  // S3 may serialize singleton Action/Resource lists as scalar strings.
  const normalized = {
    ...value,
    Statement: value.Statement.map((statement) => ({
      ...statement,
      Action:
        typeof statement.Action === "string"
          ? [statement.Action]
          : statement.Action,
      Resource:
        typeof statement.Resource === "string"
          ? [statement.Resource]
          : statement.Resource,
    })),
  };
  return isDeepStrictEqual(normalized, publicPolicy());
}
const publicPolicy = () => ({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${buckets[1]}/*`],
    },
  ],
});
export async function runtimePolicyWriteDenied(admin, media, endpoint) {
  const url = `${endpoint}/${buckets[1]}?policy`;
  const current = await admin.fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!current.ok || !publicReadPolicyMatches(await current.json()))
    return false;
  // Only test an identical policy, never replace unexpected existing settings.
  const response = await media.fetch(url, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify(publicPolicy()),
  });
  return [401, 403].includes(response.status);
}
const check = async (id, operation) => {
  try {
    checks.push({ id, passed: Boolean(await operation()) });
  } catch {
    // SDK/CLI errors may contain request URLs or credentials. Never log them.
    checks.push({ id, passed: false });
  }
  return checks.at(-1).passed;
};
function docker(args, extraEnv = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

/** Never accept an arbitrary resource endpoint for a mutating probe. */
export function isLocalServiceTarget(web) {
  try {
    const database = new URL(web.DATABASE_URL);
    const proxy = new URL(web.PLANETSCALE_DATABASE_URL);
    return (
      database.protocol === "mysql:" &&
      database.hostname === "127.0.0.1" &&
      database.port === "3307" &&
      database.pathname === `/${databaseName}` &&
      database.username === "loyalty_dev" &&
      !!database.password &&
      !database.search &&
      !database.hash &&
      proxy.protocol === "http:" &&
      proxy.hostname === "127.0.0.1" &&
      proxy.port === "3902" &&
      proxy.pathname === database.pathname &&
      proxy.username === database.username &&
      proxy.password === database.password &&
      !proxy.search &&
      !proxy.hash &&
      web.UPSTASH_REDIS_REST_URL === "http://127.0.0.1:8079" &&
      web.STORAGE_ENDPOINT === "http://127.0.0.1:9002" &&
      web.STORAGE_PRIVATE_BUCKET === buckets[0] &&
      web.STORAGE_PUBLIC_BUCKET === buckets[1]
    );
  } catch {
    return false;
  }
}

async function verify() {
  if (process.argv.slice(2).join(" ") !== "--confirm-local-probes") {
    throw new Error("Explicit confirmation required");
  }
  const web = parse(join(root, "apps/web/.env.loyalty.local"));
  if (!isLocalServiceTarget(web)) throw new Error("Unsafe resource target");
  const directory = join(root, secretDirectory);
  if (
    !(await check("private_credential_files", () =>
      privateCredentialFiles(root),
    ))
  )
    throw new Error("Unsafe credential permissions");

  // Confirm the exact Docker project and network/volume ownership before writes.
  const containers = JSON.parse(
    docker([
      "inspect",
      ...["mysql", "sql-http", "redis", "redis-http", "media"].map(
        (name) => `weletic-loyalty-dev-${name}-1`,
      ),
    ]),
  );
  const owned = containers.every(
    (container) =>
      container.State.Running &&
      container.Config.Labels["com.docker.compose.project"] ===
        "weletic-loyalty-dev" &&
      Object.values(container.NetworkSettings.Ports || {}).every(
        (bindings) =>
          !bindings ||
          bindings.every((binding) => binding.HostIp === "127.0.0.1"),
      ) &&
      Object.keys(container.NetworkSettings.Networks).every((name) =>
        name.startsWith("weletic-loyalty-dev_"),
      ) &&
      container.Mounts.every((mount) =>
        mount.Type === "volume"
          ? mount.Name.startsWith("weletic-loyalty-dev_")
          : mount.Source.startsWith(`${directory}/`) && !mount.RW,
      ),
  );
  await check("owned_loopback_containers", () => owned);
  if (!owned) throw new Error("Resource ownership failed");
  const expectedPorts = {
    mysql: "3307",
    "sql-http": "3902",
    "redis-http": "8079",
    media: "9002",
  };
  const published = Object.entries(expectedPorts).every(([name, port]) => {
    const container = containers.find(
      (item) => item.Name === `/weletic-loyalty-dev-${name}-1`,
    );
    const bindings = Object.values(container.NetworkSettings.Ports)
      .flat()
      .filter(Boolean);
    return (
      bindings.length === 1 &&
      bindings[0].HostIp === "127.0.0.1" &&
      bindings[0].HostPort === port
    );
  });
  await check("expected_loopback_ports_published", () => published);
  if (!published) throw new Error("Host port mapping failed");
  const networks = JSON.parse(
    docker([
      "network",
      "inspect",
      "weletic-loyalty-dev_database",
      "weletic-loyalty-dev_cache",
      "weletic-loyalty-dev_media",
    ]),
  );
  const isolated = networks.every(
    (network) =>
      network.Internal &&
      network.Labels["com.docker.compose.project"] === "weletic-loyalty-dev",
  );
  await check("internal_networks", () => isolated);
  if (!isolated) throw new Error("Network isolation failed");

  const password = decodeURIComponent(new URL(web.DATABASE_URL).password);
  const sql = (query) =>
    docker(
      [
        "exec",
        "--env",
        "MYSQL_PWD",
        "weletic-loyalty-dev-mysql-1",
        "mysql",
        "--host=127.0.0.1",
        "--user=loyalty_dev",
        `--database=${databaseName}`,
        "--batch",
        "--raw",
        "--skip-column-names",
        "--execute",
        query,
      ],
      { MYSQL_PWD: password },
    );
  const proxy = connect({
    url: web.PLANETSCALE_DATABASE_URL,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
  });
  await check("sql_proxy_same_database_and_server", async () => {
    const native = sql(
      "SELECT DATABASE(), @@server_uuid, CURRENT_USER()",
    ).split("\t");
    const result = await proxy.execute(
      "SELECT DATABASE() AS db, @@server_uuid AS uuid, CURRENT_USER() AS principal",
    );
    const row = result.rows[0];
    return (
      native[0] === databaseName &&
      row.db === native[0] &&
      row.uuid === native[1] &&
      row.principal === native[2] &&
      native[2].startsWith("loyalty_dev@")
    );
  });
  await check("database_scoped_grants", () => {
    const grants = sql("SHOW GRANTS FOR CURRENT_USER()").split("\n");
    return exactDatabaseGrants(grants, sql("SELECT @@partial_revokes") === "1");
  });
  await check("database_system_table_denied", async () => {
    try {
      await proxy.execute("SELECT COUNT(*) FROM mysql.user");
      return false;
    } catch (error) {
      return /access denied|command denied|permission denied/i.test(
        error.message || "",
      );
    }
  });

  const redis = new Redis({
    url: web.UPSTASH_REDIS_REST_URL,
    token: web.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    signal: () => AbortSignal.timeout(5000),
  });
  const probeId = `weletic-isolation-probe:${randomUUID()}`;
  await check("redis_signed_roundtrip", async () => {
    try {
      const created = await redis.set(probeId, "synthetic-probe", {
        nx: true,
        ex: 30,
      });
      return (
        created === "OK" && (await redis.get(probeId)) === "synthetic-probe"
      );
    } finally {
      await redis.del(probeId);
    }
  });
  await check("redis_anonymous_denied", async () => {
    const response = await fetch(web.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(5000),
    });
    // The local SRH adapter reports missing authorization as HTTP 400.
    return (
      [401, 403].includes(response.status) ||
      (response.status === 400 &&
        (await response.json()).error ===
          "Missing/Invalid authorization header")
    );
  });

  const media = new AwsClient({
    accessKeyId: web.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: web.STORAGE_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const adminCredentials = JSON.parse(
    readFileSync(join(directory, "s3-admin.json"), "utf8"),
  );
  const admin = new AwsClient({
    accessKeyId: adminCredentials.accessKey,
    secretAccessKey: adminCredentials.secretKey,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  // Deliberate setup write: anonymous GetObject only on the public bucket.
  const policySafe = await check("public_read_policy", async () => {
    const policy = publicPolicy();
    const current = await admin.fetch(
      `${web.STORAGE_ENDPOINT}/${buckets[1]}?policy`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (current.ok) return publicReadPolicyMatches(await current.json());
    if (current.status !== 404) return false;
    const response = await admin.fetch(
      `${web.STORAGE_ENDPOINT}/${buckets[1]}?policy`,
      {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify(policy),
      },
    );
    return response.ok;
  });
  if (!policySafe)
    throw new Error(
      "Unexpected public policy; further media mutations refused",
    );
  for (const bucket of buckets) {
    const object = `${web.STORAGE_ENDPOINT}/${bucket}/isolation-probe/${randomUUID()}`;
    await check(
      `${bucket.endsWith("private") ? "private" : "public"}_media_permissions`,
      async () => {
        try {
          const put = await media.fetch(object, {
            method: "PUT",
            body: "synthetic-media-probe",
            signal: AbortSignal.timeout(5000),
          });
          if (!put.ok) return false;
          const get = await media.fetch(object, {
            signal: AbortSignal.timeout(5000),
          });
          const anonymous = await fetch(object, {
            signal: AbortSignal.timeout(5000),
          });
          const anonymousWrite = await fetch(object, {
            method: "PUT",
            body: "must-be-rejected",
            signal: AbortSignal.timeout(5000),
          });
          return (
            get.ok &&
            (await get.text()) === "synthetic-media-probe" &&
            (bucket === buckets[0]
              ? [401, 403].includes(anonymous.status)
              : anonymous.ok &&
                (await anonymous.text()) === "synthetic-media-probe") &&
            [401, 403].includes(anonymousWrite.status)
          );
        } finally {
          const removed = await media.fetch(object, {
            method: "DELETE",
            signal: AbortSignal.timeout(5000),
          });
          if (!removed.ok) throw new Error("Synthetic probe cleanup failed");
        }
      },
    );
  }
  await check("runtime_media_cannot_manage_policy", () =>
    runtimePolicyWriteDenied(admin, media, web.STORAGE_ENDPOINT),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await verify();
  } catch {
    checks.push({ id: "verification_completed", passed: false });
  }
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  console.log(
    JSON.stringify(
      {
        status: passed ? "local_services_verified" : "blocked",
        appInstalled: false,
        checks,
      },
      null,
      2,
    ),
  );
  process.exitCode = passed ? 0 : 1;
}
