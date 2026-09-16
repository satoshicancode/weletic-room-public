import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { useNodeShopifyBuild } from "../../packages/shopify-app/node-build-policy.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("Vercel remains the default; Node releases and existing probes opt in", () => {
  for (const env of [
    {},
    { WELETIC_SHOPIFY_BUILD_TARGET: "vercel" },
    { WELETIC_LOCAL_CONTAINER_BUILD: "0" },
  ]) {
    assert.equal(useNodeShopifyBuild(env), false);
  }
  for (const env of [
    { WELETIC_SHOPIFY_BUILD_TARGET: "node" },
    { WELETIC_LOCAL_CONTAINER_BUILD: "1" },
  ]) {
    assert.equal(useNodeShopifyBuild(env), true);
  }
  for (const target of [
    "",
    "Node",
    " node",
    "worker",
    "never-print-private-input",
  ]) {
    assert.throws(
      () => useNodeShopifyBuild({ WELETIC_SHOPIFY_BUILD_TARGET: target }),
      { message: "Unsupported Shopify build target" },
    );
  }
  assert.throws(
    () =>
      useNodeShopifyBuild({
        WELETIC_SHOPIFY_BUILD_TARGET: "vercel",
        WELETIC_LOCAL_CONTAINER_BUILD: "1",
      }),
    /Conflicting/,
  );
});

test("Vite selects the adapter from the shared build policy", () => {
  const vite = read("../../packages/shopify-app/vite.config.ts");
  assert.match(
    vite,
    /presets: useNodeShopifyBuild\(process.env\) \? \[\] : \[vercelPreset\(\)\]/,
  );
});

test("candidate image builds from the locked source with networking disabled after install", () => {
  const docker = read("./Shopify.Dockerfile");
  assert.match(docker, /pnpm install --frozen-lockfile/);
  assert.match(
    docker,
    /RUN --network=none WELETIC_SHOPIFY_BUILD_TARGET=node pnpm --filter @weletic\/shopify-app build/,
  );
  assert.doesNotMatch(
    docker,
    /WELETIC_LOCAL_CONTAINER_BUILD|cloudflare-local|probe\.mjs|\bARG\b|--mount=type=secret/,
  );
  const afterInstall = docker.split("FROM dependencies AS build")[1];
  for (const line of afterInstall
    .split("\n")
    .filter((line) => line.startsWith("RUN "))) {
    assert.ok(line.startsWith("RUN --network=none "));
  }
});

test("fresh runtime wires the guarded entrypoint and contains no build environment", () => {
  const docker = read("./Shopify.Dockerfile");
  const runtime = docker.split(" AS shopify\n")[1];
  assert.ok(runtime);
  assert.match(
    docker,
    /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS shopify/,
  );
  assert.match(runtime, /^USER node$/m);
  assert.match(runtime, /^STOPSIGNAL SIGTERM$/m);
  assert.match(
    runtime,
    /^ENTRYPOINT \["node", "\/workspace\/infra\/cloudflare-release\/start.mjs", "shopify"\]$/m,
  );
  assert.match(
    runtime,
    /COPY infra\/cloudflare-release\/start.mjs infra\/cloudflare-release\/runtime-policy.mjs/,
  );
  assert.match(
    runtime,
    /COPY packages\/shopify-app\/app\/public-runtime-policy.mjs/,
  );
  assert.match(
    runtime,
    /COPY --from=build \/workspace\/packages\/shopify-app\/build/,
  );
  assert.doesNotMatch(
    runtime,
    /WELETIC_SHOPIFY_BUILD_TARGET|SHOPIFY_API_SECRET|WELETIC_SHOPIFY_SERVICE_SECRET|COPY \. |COPY apps\/web|COPY packages packages/,
  );
});

test("dedicated context excludes credentials, local outputs and probe directory", () => {
  const patterns = read("./Shopify.Dockerfile.dockerignore").trim().split("\n");
  assert.equal(patterns[0], "**");
  for (const name of [
    "**/.env*",
    "**/.dev.vars*",
    "**/credentials.json",
    "**/.npmrc",
    "**/.git",
    "**/node_modules",
    "**/build",
    "**/dist",
    "**/.next*",
    "**/.shopify",
    "**/.wrangler",
    "**/*.pem",
    "**/*.key",
    "**/*.sql",
    "**/*.csv",
  ]) {
    assert.ok(patterns.includes(name), name);
    assert.ok(patterns.indexOf(name) > patterns.indexOf("!packages/**"));
  }
  assert.ok(!patterns.includes("!infra/cloudflare-local/**"));
});
