import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseName, hasRetainedEnvironment } from "./init.mjs";
import { isLocalServiceTarget } from "./verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/web/package.json"));
const { parse } = require("dotenv-flow");
// Explicitly exclude ambient application/transport credentials and dotenv overlays.
const cleanEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
function run(command, args, extraEnv = {}, timeout = 30_000) {
  return execFileSync(command, args, {
    cwd: join(root, "apps/web"),
    env: { ...cleanEnvironment(), ...extraEnv },
    timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  if (
    process.argv.slice(2).join(" ") !== "--confirm-empty-local-schema" ||
    hasRetainedEnvironment(root)
  ) {
    throw new Error("Unsafe invocation");
  }
  const web = parse(join(root, "apps/web/.env.loyalty.local"));
  if (!isLocalServiceTarget(web)) throw new Error("Unsafe target");
  // This repeats the actual ownership, permission and proxy-target checks.
  run(
    process.execPath,
    [
      join(root, "infra/shopify-development/verify.mjs"),
      "--confirm-local-probes",
    ],
    {},
    120_000,
  );
  const sql = (query) =>
    run(
      "docker",
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
        "--skip-column-names",
        "--execute",
        query,
      ],
      { MYSQL_PWD: decodeURIComponent(new URL(web.DATABASE_URL).password) },
    );
  const tableCount = () =>
    Number(
      sql(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${databaseName}'`,
      ),
    );
  if (tableCount() !== 0)
    throw new Error("Database is not empty; automatic restaging is refused");
  run("pnpm", ["exec", "prisma", "validate", "--schema=./prisma/schema"], {
    DATABASE_URL: web.DATABASE_URL,
  });
  run(
    "pnpm",
    [
      "exec",
      "prisma",
      "db",
      "push",
      "--skip-generate",
      "--schema=./prisma/schema",
    ],
    { DATABASE_URL: web.DATABASE_URL },
    120_000,
  );
  const count = tableCount();
  if (count === 0) throw new Error("Schema was not created");
  console.log(
    JSON.stringify({
      status: "empty_local_schema_staged",
      tableCount: count,
      importedRecords: 0,
      appInstalled: false,
      migrationsHistoryProven: false,
    }),
  );
} catch {
  // Prisma and Docker errors can contain credentials. Keep output fixed/redacted.
  console.error(
    "Schema staging refused or failed. Inspect guards and local schema state; do not drop tables or use --accept-data-loss to retry.",
  );
  process.exitCode = 1;
}
