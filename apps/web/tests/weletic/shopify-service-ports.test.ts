import { parse } from "dotenv-flow";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLocalServices } from "../../../../infra/shopify-development/init.mjs";
import { buildPreviewEnvironment } from "../../../../infra/shopify-development/preview-runtime.mjs";
import { buildRuntimeEnvironment } from "../../../../infra/shopify-development/runtime-policy.mjs";
import {
  DEFAULT_SERVICE_PORTS,
  parseProvisioningFlags,
  readLocalServicePorts,
  validateServicePorts,
} from "../../../../infra/shopify-development/service-ports.mjs";
import { isLocalServiceTarget } from "../../../../infra/shopify-development/verify.mjs";

const roots: string[] = [];
const alternate = { mysql: "13307", sqlHttp: "13902" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "weletic-ports-test-"));
  roots.push(root);
  for (const path of ["apps/web", "packages/shopify-app"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), "{}");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("isolated SQL port configuration", () => {
  it("preserves legacy defaults and rejects malformed explicit ports", () => {
    expect(readLocalServicePorts(fixture())).toEqual(DEFAULT_SERVICE_PORTS);
    expect(parseProvisioningFlags(["--confirm-local-provisioning"])).toEqual(
      DEFAULT_SERVICE_PORTS,
    );
    expect(
      parseProvisioningFlags([
        "--mysql-port=13307",
        "--confirm-local-provisioning",
        "--sql-http-port=13902",
      ]),
    ).toEqual(alternate);
    for (const value of [
      null,
      [],
      {},
      { ...alternate, host: "localhost" },
      { ...alternate, mysql: 13307 },
      { ...alternate, mysql: "013307" },
      { ...alternate, mysql: "80" },
      { ...alternate, mysql: "65536" },
      { ...alternate, mysql: "8890" },
      { ...alternate, mysql: alternate.sqlHttp },
    ]) {
      expect(() => validateServicePorts(value)).toThrow();
    }
    for (const args of [
      [],
      ["--confirm-local-provisioning", "--mysql-port=13307"],
      [
        "--confirm-local-provisioning",
        "--mysql-port=13307=x",
        "--sql-http-port=13902",
      ],
      [
        "--confirm-local-provisioning",
        "--mysql-port=13307",
        "--mysql-port=13902",
      ],
    ])
      expect(() => parseProvisioningFlags(args)).toThrow();
  });
  it("binds both runtime URLs to explicit ports and ignores ambient overrides", () => {
    const root = fixture();
    initializeLocalServices(root, alternate);
    const ports = readLocalServicePorts(root);
    const web = parse(join(root, "apps/web/.env.loyalty.local"));
    const shopify = parse(
      join(root, "packages/shopify-app/.env.loyalty.local"),
    );
    expect(isLocalServiceTarget(web)).toBe(false);
    expect(isLocalServiceTarget(web, ports)).toBe(true);
    expect(() =>
      buildRuntimeEnvironment("web", web, shopify, {
        MYSQL_PORT: alternate.mysql,
      }),
    ).toThrow();
    const env = buildRuntimeEnvironment(
      "web",
      web,
      shopify,
      { MYSQL_PORT: "3307" },
      ports,
    );
    expect(new URL(env.DATABASE_URL).port).toBe(alternate.mysql);
    expect(env.MYSQL_PORT).toBeUndefined();
    expect(
      buildPreviewEnvironment(
        "web",
        web,
        shopify,
        {},
        {
          apiOrigin: "https://core-api.trycloudflare.com",
          appOrigin: "https://core-app.trycloudflare.com",
        },
        ports,
      ).DATABASE_URL,
    ).toBe(web.DATABASE_URL);
    for (const [key, value] of [
      ["DATABASE_URL", web.DATABASE_URL.replace(":13307/", ":3307/")],
      [
        "PLANETSCALE_DATABASE_URL",
        web.PLANETSCALE_DATABASE_URL.replace(":13902/", ":3902/"),
      ],
      ["DATABASE_URL", web.DATABASE_URL.replace("127.0.0.1", "remote.invalid")],
      [
        "DATABASE_URL",
        web.DATABASE_URL.replace("weletic_loyalty_dev", "retained"),
      ],
    ]) {
      expect(isLocalServiceTarget({ ...web, [key]: value }, ports)).toBe(false);
    }
    expect(
      readFileSync(
        join(root, ".env.loyalty-secrets.local/compose-ports.yaml"),
        "utf8",
      ),
    ).toBe(
      'services:\n  mysql:\n    ports: !override ["127.0.0.1:13307:3306"]\n  sql-http:\n    ports: !override ["127.0.0.1:13902:3900"]\n',
    );
    expect(() =>
      initializeLocalServices(root, DEFAULT_SERVICE_PORTS),
    ).toThrow();
  });
  it("fails closed for public, malformed, oversized and symlinked port files", () => {
    const root = fixture();
    initializeLocalServices(root);
    const path = join(root, ".env.loyalty-secrets.local/service-ports.json");
    chmodSync(path, 0o644);
    expect(() => readLocalServicePorts(root)).toThrow();
    chmodSync(path, 0o600);
    for (const data of [
      "{",
      " ".repeat(1025),
      JSON.stringify({ ...alternate, extra: true }),
    ]) {
      writeFileSync(path, data);
      expect(() => readLocalServicePorts(root)).toThrow();
    }
    rmSync(path);
    symlinkSync(join(root, "missing"), path);
    expect(() => readLocalServicePorts(root)).toThrow();
    rmSync(path);
    expect(readLocalServicePorts(root)).toEqual(DEFAULT_SERVICE_PORTS);
    const secondRoot = fixture();
    symlinkSync(
      join(root, ".env.loyalty-secrets.local"),
      join(secondRoot, ".env.loyalty-secrets.local"),
    );
    expect(() => readLocalServicePorts(secondRoot)).toThrow();
  });
});
