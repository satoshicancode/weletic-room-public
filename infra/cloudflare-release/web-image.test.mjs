import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertWebBuildContext, webBuildEnvironment } from "./web-build.mjs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("build uses fixed public origins, loopback placeholders and no inherited runtime secrets", () => {
  const env = webBuildEnvironment();
  assert.equal(env.WELETIC_WEB_BUILD_PROFILE, "loyalty-only");
  assert.equal(
    env.NEXT_PUBLIC_APP_DOMAIN,
    "https://loyalty-api-dev.weletic.com",
  );
  assert.equal(env.NEXT_PUBLIC_API_DOMAIN, env.NEXT_PUBLIC_APP_DOMAIN);
  assert.equal(env.NEXT_PUBLIC_ADMIN_DOMAIN, "https://disabled-admin.invalid");
  assert.equal(
    env.NEXT_PUBLIC_PARTNERS_DOMAIN,
    "https://disabled-partners.invalid",
  );
  assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
  assert.equal(env.WELETIC_LOCAL_CONTAINER_BUILD, undefined);
  assert.equal(env.QSTASH_TOKEN, undefined);
  assert.equal(env.RESEND_API_KEY, undefined);
  assert.equal(env.CRON_SECRET, "build-only-cron-placeholder-not-runtime");
});

test("build rejects host/dotenv execution and unbounded container resources", () => {
  const values = {
    "memory.max": "6442450944",
    "memory.swap.max": "0",
    "cpu.max": "200000 100000",
  };
  const exists = (path) => path === "/.dockerenv";
  const read = (path) => values[path.split("/").at(-1)];
  assert.doesNotThrow(() => assertWebBuildContext(exists, read));
  assert.doesNotThrow(() =>
    assertWebBuildContext(
      (path) => path === "/opt/weletic-release-build",
      read,
    ),
  );
  assert.throws(() => assertWebBuildContext(() => false, read));
  assert.throws(() => assertWebBuildContext(() => true, read));
  for (const [key, value] of [
    ["memory.max", "max"],
    ["memory.max", "6442450945"],
    ["memory.swap.max", "1"],
    ["cpu.max", "max 100000"],
    ["cpu.max", "300000 100000"],
  ]) {
    assert.throws(() =>
      assertWebBuildContext(exists, (path) =>
        path.endsWith(key) ? value : read(path),
      ),
    );
  }
});

test("fresh web and scoped outbox image recipes preserve guarded startup and dependencies", () => {
  const docker = read("./Web.Dockerfile");
  assert.match(docker, /pnpm install --frozen-lockfile/);
  assert.match(
    docker,
    /pnpm --frozen-lockfile --store-dir \/pnpm\/store --filter web deploy \/opt\/web-runtime/,
  );
  assert.match(
    docker,
    /RUN --network=none cd \/opt\/web-runtime && pnpm exec prisma generate --schema=\.\/prisma\/schema/,
  );
  assert.match(
    docker,
    /RUN --network=none mkdir -p \/opt\/weletic-release-build && node infra\/cloudflare-release\/web-build.mjs/,
  );
  assert.doesNotMatch(
    docker,
    /cloudflare-local|WELETIC_LOCAL_CONTAINER_BUILD|\bARG\b|--mount=type=secret/,
  );
  const runtime = docker.split(" AS runtime\n")[1];
  assert.ok(runtime);
  assert.match(
    runtime,
    /COPY --from=runtime-dependencies \/opt\/web-runtime\/node_modules \.\/apps\/web\/node_modules/,
  );
  assert.doesNotMatch(runtime, /COPY --from=source \/workspace\/node_modules/);
  assert.match(runtime, /^USER node$/m);
  assert.match(runtime, /^STOPSIGNAL SIGTERM$/m);
  assert.match(
    runtime,
    /loyalty-web.mjs infra\/cloudflare-release\/loyalty-routes.mjs/,
  );
  for (const role of ["web", "outbox"])
    assert.ok(
      runtime.includes(`"start.mjs", "${role}"`) ||
        runtime.includes(
          `"/workspace/infra/cloudflare-release/start.mjs", "${role}"`,
        ),
    );
  assert.match(runtime, /COPY apps\/web\/ui/);
  assert.match(runtime, /COPY apps\/web\/tsconfig.json/);
  assert.doesNotMatch(
    runtime,
    /build-only-|WELETIC_WEB_BUILD_PROFILE|COPY \. /,
  );
  const patterns = read("./Web.Dockerfile.dockerignore").trim().split("\n");
  assert.equal(patterns[0], "**");
  for (const pattern of [
    "**/.env*",
    "**/.dev.vars*",
    "**/credentials.json",
    "**/.npmrc",
    "**/node_modules",
    "**/.git",
    "**/.next*",
    "**/*.pem",
    "**/*.key",
    "**/*.sql",
  ])
    assert.ok(patterns.indexOf(pattern) > patterns.indexOf("!packages/**"));
});
