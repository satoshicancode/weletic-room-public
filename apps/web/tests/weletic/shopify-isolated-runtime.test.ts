import { parse } from "dotenv-flow";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeLocalServices } from "../../../../infra/shopify-development/init.mjs";
import { parseRuntimeFlags } from "../../../../infra/shopify-development/run.mjs";
import {
  buildRuntimeEnvironment,
  createRuntimeLogSink,
  runtimeArguments,
} from "../../../../infra/shopify-development/runtime-policy.mjs";

const roots: string[] = [];
function configuration() {
  const root = mkdtempSync(join(tmpdir(), "weletic-runtime-test-"));
  roots.push(root);
  for (const directory of ["apps/web", "packages/shopify-app"]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "package.json"), "{}");
  }
  initializeLocalServices(root);
  return {
    web: parse(join(root, "apps/web/.env.loyalty.local")),
    shopify: parse(join(root, "packages/shopify-app/.env.loyalty.local")),
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("isolated development runtime", () => {
  it("preserves local rewrite URLs only when isolation is explicitly enabled", () => {
    const source = readFileSync(
      new URL("../../next.config.js", import.meta.url),
      "utf8",
    );
    for (const [flag, expected] of [
      ["1", true],
      ["0", false],
      [undefined, false],
    ]) {
      const configModule = {
        exports: { skipMiddlewareUrlNormalize: undefined },
      };
      runInNewContext(source, {
        module: configModule,
        process: { env: { WELETIC_ISOLATED_DEVELOPMENT: flag } },
        console: { warn: vi.fn() },
        require: (name: string) => {
          if (name !== "next-plausible")
            throw new Error("Unexpected dependency");
          return { withPlausibleProxy: () => (config: unknown) => config };
        },
      });
      expect(configModule.exports.skipMiddlewareUrlNormalize).toBe(expected);
    }
  });
  it("scrubs inherited secrets, injected Node options and retained origins", () => {
    const { web, shopify } = configuration();
    const ambient = {
      PATH: "/usr/bin",
      HOME: "/synthetic-home",
      NODE_OPTIONS: "--import=/untrusted.mjs",
      DATABASE_URL: "mysql://retained.invalid/database",
      RESEND_API_KEY: "unapproved-delivery-key",
      NEXT_PUBLIC_API_DOMAIN: "https://retained.invalid",
      VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "untrusted.invalid",
      AWS_PROFILE: "retained",
      SHOPIFY_API_KEY: "retained-app",
    };
    const env = buildRuntimeEnvironment("web", web, shopify, ambient);
    expect(env.PATH).toBe(ambient.PATH);
    expect(env.DATABASE_URL).toBe(web.DATABASE_URL);
    expect(env.SHOPIFY_API_KEY).toBe(shopify.SHOPIFY_API_KEY);
    expect(env.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS).toBe(
      web.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS,
    );
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
    for (const key of [
      "RESEND_API_KEY",
      "AWS_PROFILE",
      "VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
    ])
      expect(env).not.toHaveProperty(key);
    expect(env.NEXT_PUBLIC_API_DOMAIN).toBe("http://api.localhost:8890");
    expect(env.NEXT_PUBLIC_PARTNERS_DOMAIN).toBe(
      "http://partners.localhost:8890",
    );
    expect(env.NEXT_PUBLIC_ADMIN_DOMAIN).toBe("http://admin.localhost:8890");
    expect(env.NEXT_DIST_DIR).toBe(".next-dev");
    expect(env.NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT).toBe("1");
    expect(env.WELETIC_ENFORCE_CRON_AUTH).toBe("1");
    const app = buildRuntimeEnvironment("shopify", web, shopify, ambient);
    for (const key of [
      "DATABASE_URL",
      "CRON_SECRET",
      "ENCRYPTION_KEY",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
      expect(app).not.toHaveProperty(key);
    expect(app.WELETIC_API_URL).toBe("http://app.localhost:8890");
    expect(app.WELETIC_ISOLATED_DEVELOPMENT).toBe("1");
    expect(app.SHOPIFY_API_KEY).toBe(env.SHOPIFY_API_KEY);
    expect(app).not.toHaveProperty("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS");
  });

  it("fails startup before either process runs when its privacy key is missing", () => {
    const { web, shopify } = configuration();
    for (const app of ["web", "shopify"])
      expect(() =>
        buildRuntimeEnvironment(
          app,
          { ...web, WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS: "" },
          shopify,
          {},
        ),
      ).toThrow("Isolated Shopify privacy key is missing or invalid");
  });

  it("redacts the complete privacy keyring from runtime output", () => {
    const { web } = configuration();
    const emit = vi.fn();
    const sink = createRuntimeLogSink([web], emit);
    sink.write(
      Buffer.from(`privacy=${web.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS}\n`),
    );
    expect(emit).toHaveBeenCalledWith("privacy=[REDACTED]\n");
  });

  it("rejects a different app identity before launching either runtime", () => {
    const { web, shopify } = configuration();
    for (const app of ["web", "shopify"])
      expect(() =>
        buildRuntimeEnvironment(
          app,
          web,
          { ...shopify, SHOPIFY_API_KEY: "other-app" },
          {},
        ),
      ).toThrow("Unsafe runtime target");
  });

  it.each([
    "RESEND_API_KEY",
    "NODE_OPTIONS",
    "NEXT_PUBLIC_API_DOMAIN",
    "UPSTASH_REDIS_REST_GLOBAL_TOKEN",
  ])("rejects nonempty unreviewed file configuration: %s", (key) => {
    const { web, shopify } = configuration();
    expect(() =>
      buildRuntimeEnvironment(
        "web",
        { ...web, [key]: "unreviewed" },
        shopify,
        {},
      ),
    ).toThrow("Unreviewed runtime configuration");
    expect(() =>
      buildRuntimeEnvironment(
        "web",
        web,
        { ...shopify, [key]: "unreviewed" },
        {},
      ),
    ).toThrow("Unreviewed runtime configuration");
  });

  it.each([
    [
      "DATABASE_URL",
      "mysql://loyalty_dev:synthetic@127.0.0.1:3306/weletic_loyalty_dev",
    ],
    ["NEXTAUTH_URL", "http://app.localhost:8888"],
    ["NEXT_PUBLIC_APP_DOMAIN", "http://app.localhost:8888"],
    ["SHOPIFY_APP_URL", "http://127.0.0.1:3000"],
    ["WELETIC_ENFORCE_CRON_AUTH", "0"],
  ])("rejects a retained or unsafe web target: %s", (key, value) => {
    const { web, shopify } = configuration();
    expect(() =>
      buildRuntimeEnvironment("web", { ...web, [key]: value }, shopify, {}),
    ).toThrow("Unsafe runtime target");
  });

  it("rejects incorrect Shopify origins and ports before launching either app", () => {
    const { web, shopify } = configuration();
    for (const field of [
      { PORT: "3000" },
      { WELETIC_API_URL: "http://localhost:8888" },
      { SHOPIFY_APP_URL: "https://foreign.invalid" },
    ])
      expect(() =>
        buildRuntimeEnvironment("web", web, { ...shopify, ...field }, {}),
      ).toThrow("Unsafe runtime target");
  });

  it("requires explicit confirmation, target and retained comparison files", () => {
    const flags = [
      "--app=web",
      "--retained-web=/retained/web",
      "--retained-shopify=/retained/shopify",
      "--confirm-local-runtime",
    ];
    expect(parseRuntimeFlags(flags).app).toBe("web");
    for (const invalid of [
      flags.slice(0, 3),
      [...flags, "--force"],
      flags.map((flag) => (flag === "--app=web" ? "--app=worker" : flag)),
      flags.map((flag) =>
        flag.startsWith("--retained-web=") ? "--retained-web=" : flag,
      ),
    ])
      expect(() => parseRuntimeFlags(invalid)).toThrow();
    expect(runtimeArguments("web")).toEqual([
      "dev",
      "--turbopack",
      "--hostname",
      "127.0.0.1",
      "--port",
      "8890",
    ]);
    expect(runtimeArguments("shopify")).toEqual([
      "vite:dev",
      "--host",
      "127.0.0.1",
      "--port",
      "3002",
      "--strictPort",
    ]);
    expect(() => runtimeArguments("worker")).toThrow();
  });

  it("redacts split credentials, encoded URL passwords and final incomplete lines", () => {
    const output: string[] = [];
    const password = "synthetic/password";
    const encoded = encodeURIComponent(password);
    const secret = "synthetic-service-secret";
    const url = `mysql://user:${encoded}@127.0.0.1/db`;
    const sink = createRuntimeLogSink(
      [{ WELETIC_SHOPIFY_SERVICE_SECRET: secret, DATABASE_URL: url }],
      (line: string) => output.push(line),
    );
    sink.write(Buffer.from(`safe\n${secret.slice(0, 10)}`));
    expect(output).toEqual(["safe\n"]);
    sink.write(
      Buffer.from(
        `${secret.slice(10)}\n${url}\n${encoded}\n\u001b[31m${password}\u001b[0m`,
      ),
    );
    sink.end();
    expect(output.join("")).toBe(
      "safe\n[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]",
    );
  });

  it("drops oversized lines without leaking their tail and resumes on newline", () => {
    const output: string[] = [];
    const sink = createRuntimeLogSink([], (line: string) => output.push(line));
    sink.write(Buffer.from("x".repeat(65537)));
    sink.write(Buffer.from("sensitive-tail\nsafe\n"));
    sink.end();
    expect(output).toEqual(["[Oversize runtime log line omitted]\n", "safe\n"]);
  });

  it("pins the shared API origin without changing existing defaults", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_DOMAIN", "http://api.localhost:8890/");
    let constants = await import(
      "../../../../packages/utils/src/constants/main"
    );
    expect(constants.API_DOMAIN).toBe("http://api.localhost:8890");
    expect(constants.API_HOSTNAMES.has("api.localhost:8890")).toBe(true);
    for (const [environment, expected] of [
      ["development", "http://api.localhost:8888"],
      ["production", "https://api.dub.co"],
      ["preview", "https://api-staging.dub.co"],
    ]) {
      vi.resetModules();
      vi.stubEnv("NEXT_PUBLIC_API_DOMAIN", undefined);
      vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", environment);
      constants = await import("../../../../packages/utils/src/constants/main");
      expect(constants.API_DOMAIN).toBe(expected);
    }
  });
});
