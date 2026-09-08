import { parse } from "dotenv-flow";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAppSecret,
  startCredentialSetup,
} from "../../../../infra/shopify-development/configure-app-secret.mjs";
import {
  initializeLocalServices,
  secretDirectory,
} from "../../../../infra/shopify-development/init.mjs";
import {
  exactDatabaseGrants,
  isLocalServiceTarget,
  privateCredentialFiles,
  publicReadPolicyMatches,
  runtimePolicyWriteDenied,
} from "../../../../infra/shopify-development/verify.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "weletic-services-test-"));
  roots.push(root);
  for (const directory of ["apps/web", "packages/shopify-app"]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "package.json"), "{}");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("isolated local service credentials", () => {
  it("guards the real loopback form and permits exactly one concurrent submission", async () => {
    const root = fixture();
    initializeLocalServices(root);
    const setup = await startCredentialSetup(root);
    try {
      const secret = `shpss_${"synthetic".repeat(8)}`;
      const origin = new URL(setup.url).origin;
      const headers = {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const body = new URLSearchParams({ secret }).toString();
      const page = await fetch(setup.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("referrer-policy")).toBe("same-origin");
      expect(await page.text()).not.toContain(secret);
      expect((await fetch(`${origin}/wrong-path`)).status).toBe(404);
      // Native fetch normalizes Host; use HTTP to actually send the wrong header.
      const wrongHostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            setup.url,
            { headers: { Host: "foreign.invalid" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      expect(wrongHostStatus).toBe(404);
      for (const badHeaders of [
        { ...headers, Origin: "https://foreign.invalid" },
        { "Content-Type": headers["Content-Type"] },
        { ...headers, "Content-Type": "application/json" },
      ]) {
        expect(
          (
            await fetch(setup.url, {
              method: "POST",
              headers: badHeaders,
              body,
            })
          ).status,
        ).toBe(403);
      }
      for (const invalidBody of [
        `${body}&${body}`,
        `secret=${"x".repeat(2100)}`,
        "secret=invalid",
      ]) {
        expect(
          (
            await fetch(setup.url, {
              method: "POST",
              headers,
              body: invalidBody,
            })
          ).status,
        ).toBe(400);
      }
      expect(
        parse(join(root, "apps/web/.env.loyalty.local")).SHOPIFY_WEBHOOK_SECRET,
      ).toBe("");
      const attempts = await Promise.allSettled(
        [1, 2].map(async () => {
          const response = await fetch(setup.url, {
            method: "POST",
            headers,
            body,
          });
          expect(await response.text()).not.toContain(secret);
          return response.status;
        }),
      );
      expect(
        attempts.filter(
          (result) => result.status === "fulfilled" && result.value === 200,
        ),
      ).toHaveLength(1);
      expect(
        parse(join(root, "apps/web/.env.loyalty.local")).SHOPIFY_WEBHOOK_SECRET,
      ).toBe(secret);
      expect(setup.server.listening).toBe(false);
    } finally {
      setup.close();
    }
  });
  it("configures the approved existing app secret once in both private files", () => {
    const root = fixture();
    initializeLocalServices(root);
    const secret = `shpss_${"synthetic".repeat(8)}`;
    configureAppSecret(root, secret);
    expect(
      parse(join(root, "apps/web/.env.loyalty.local")).SHOPIFY_WEBHOOK_SECRET,
    ).toBe(secret);
    expect(
      parse(join(root, "packages/shopify-app/.env.loyalty.local"))
        .SHOPIFY_API_SECRET,
    ).toBe(secret);
    expect(privateCredentialFiles(root)).toBe(true);
    expect(() => configureAppSecret(root, secret)).toThrow(
      "Refuse existing or wrong app credentials",
    );
  });
  it("rejects malformed secrets and configuration for another app before writing", () => {
    const root = fixture();
    initializeLocalServices(root);
    expect(() => configureAppSecret(root, "invalid\nINJECTED=yes")).toThrow(
      "Invalid secret",
    );
    const path = join(root, "packages/shopify-app/.env.loyalty.local");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "c7d49cebb06e445db345bb200f966a03",
        "another-app",
      ),
    );
    expect(() =>
      configureAppSecret(root, `shpss_${"synthetic".repeat(8)}`),
    ).toThrow("Refuse existing or wrong app credentials");
    expect(
      parse(join(root, "apps/web/.env.loyalty.local")).SHOPIFY_WEBHOOK_SECRET,
    ).toBe("");
  });
  it.each(["apps/web", "packages/shopify-app"])(
    "rejects readable or symlinked runtime secrets in %s",
    (directory) => {
      const root = fixture();
      initializeLocalServices(root);
      expect(privateCredentialFiles(root)).toBe(true);
      const path = join(root, directory, ".env.loyalty.local");
      chmodSync(path, 0o644);
      expect(privateCredentialFiles(root)).toBe(false);
      chmodSync(path, 0o600);
      expect(privateCredentialFiles(root)).toBe(true);
      rmSync(path);
      symlinkSync(join(root, secretDirectory, "mysql-app"), path);
      expect(privateCredentialFiles(root)).toBe(false);
    },
  );
  it("rejects database wildcard and delegation privileges", () => {
    const usage = "GRANT USAGE ON *.* TO `loyalty_dev`@`%`";
    const grant =
      "GRANT ALL PRIVILEGES ON `weletic\\_loyalty\\_dev`.* TO `loyalty_dev`@`%`";
    expect(exactDatabaseGrants([usage, grant], false)).toBe(true);
    expect(
      exactDatabaseGrants([usage, grant.replaceAll("\\", "")], false),
    ).toBe(false);
    expect(exactDatabaseGrants([usage, grant.replaceAll("\\", "")], true)).toBe(
      true,
    );
    expect(
      exactDatabaseGrants([usage, `${grant} WITH GRANT OPTION`], false),
    ).toBe(false);
    expect(
      exactDatabaseGrants(
        [usage, grant, "GRANT SELECT ON *.* TO `loyalty_dev`@`%`"],
        false,
      ),
    ).toBe(false);
  });
  it("never writes a policy after detecting unexpected existing settings", async () => {
    const admin = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ Version: "2012-10-17", Statement: [] }),
            { status: 200 },
          ),
        ),
    };
    const media = {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    };
    expect(
      await runtimePolicyWriteDenied(admin, media, "http://127.0.0.1:9002"),
    ).toBe(false);
    expect(media.fetch).not.toHaveBeenCalled();
  });
  it("accepts only the exact read-only public policy, including S3 scalar serialization", () => {
    const statement = {
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::weletic-loyalty-dev-public/*",
    };
    const policy = { Version: "2012-10-17", Statement: [statement] };
    expect(publicReadPolicyMatches(policy)).toBe(true);
    expect(
      publicReadPolicyMatches({
        ...policy,
        Statement: [
          {
            ...statement,
            Action: [statement.Action],
            Resource: [statement.Resource],
          },
        ],
      }),
    ).toBe(true);
    expect(
      publicReadPolicyMatches({
        ...policy,
        Statement: [{ ...statement, Action: "s3:*" }],
      }),
    ).toBe(false);
    expect(
      publicReadPolicyMatches({
        ...policy,
        Statement: [
          {
            ...statement,
            Resource: "arn:aws:s3:::weletic-loyalty-dev-private/*",
          },
        ],
      }),
    ).toBe(false);
    expect(
      publicReadPolicyMatches({ ...policy, Statement: [statement, statement] }),
    ).toBe(false);
    expect(publicReadPolicyMatches(null)).toBe(false);
  });
  it("accepts only exact local resource targets before any mutating probe", () => {
    const root = fixture();
    initializeLocalServices(root);
    const web = parse(join(root, "apps/web/.env.loyalty.local"));
    expect(isLocalServiceTarget(web)).toBe(true);
    for (const [key, value] of [
      ["DATABASE_URL", web.DATABASE_URL.replace(":3307/", ":3306/")],
      [
        "DATABASE_URL",
        web.DATABASE_URL.replace("weletic_loyalty_dev", "planetscale"),
      ],
      [
        "PLANETSCALE_DATABASE_URL",
        web.PLANETSCALE_DATABASE_URL.replace(":3902/", ":3900/"),
      ],
      ["UPSTASH_REDIS_REST_URL", "https://retained.invalid"],
      ["STORAGE_ENDPOINT", "https://retained.invalid"],
      ["STORAGE_PRIVATE_BUCKET", "retained-private"],
    ]) {
      expect(isLocalServiceTarget({ ...web, [key]: value })).toBe(false);
    }
  });

  it("creates private files without Shopify credentials or delivery transports", () => {
    const root = fixture();
    initializeLocalServices(root);
    const directory = join(root, secretDirectory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of [
      "mysql-root",
      "mysql-app",
      "redis-tokens.json",
      "s3-admin.json",
      "s3-config.json",
    ]) {
      expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
    const web = readFileSync(join(root, "apps/web/.env.loyalty.local"), "utf8");
    const shopify = readFileSync(
      join(root, "packages/shopify-app/.env.loyalty.local"),
      "utf8",
    );
    expect(web).toContain("DATABASE_URL=mysql://loyalty_dev:");
    for (const key of [
      "RESEND_API_KEY",
      "SMTP_HOST",
      "QSTASH_TOKEN",
      "SHOPIFY_WEBHOOK_SECRET",
    ]) {
      expect(web).toContain(`${key}=\n`);
    }
    expect(shopify).toContain("SHOPIFY_API_SECRET=\n");
    const config = JSON.parse(
      readFileSync(join(directory, "s3-config.json"), "utf8"),
    );
    const runtime = config.identities[1];
    expect(
      runtime.actions.every((action: string) =>
        action.includes(":weletic-loyalty-dev-"),
      ),
    ).toBe(true);
    expect(
      runtime.actions.some((action: string) => action.startsWith("Admin")),
    ).toBe(false);
    expect(web).not.toContain(config.identities[0].credentials[0].secretKey);
  });

  it("refuses to rotate existing credentials", () => {
    const root = fixture();
    initializeLocalServices(root);
    const path = join(root, secretDirectory, "mysql-app");
    const before = readFileSync(path);
    expect(() => initializeLocalServices(root)).toThrow(
      "automatic rotation is refused",
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses a checkout containing a retained runtime environment", () => {
    const root = fixture();
    writeFileSync(join(root, "apps/web/.env"), "retained-sentinel");
    expect(() => initializeLocalServices(root)).toThrow(
      "separate Weletic development checkout",
    );
    expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toBe(
      "retained-sentinel",
    );
  });
});
