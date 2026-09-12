import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicExtensionStage,
  publicExtensionFiles,
  transformPublicExtension,
  writePublicExtensionStage,
} from "../../../../infra/shopify-development/stage-public-extensions.mjs";

const root = resolve(process.cwd(), "../..");
const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true });
});

describe("offline public extension staging", () => {
  it("stages the exact ten-extension inventory with no inherited UIDs", () => {
    const files = buildPublicExtensionStage(root);
    expect(Object.keys(publicExtensionFiles)).toHaveLength(10);
    const manifests = Object.entries(files).filter(([path]) =>
      path.endsWith("shopify.extension.toml"),
    );
    expect(manifests).toHaveLength(10);
    for (const [, text] of manifests) expect(text).not.toMatch(/^uid\s*=/m);
    expect(Object.keys(files).join()).not.toMatch(
      /Checkout\.tsx|weletic-reviews|product-review|weletic-tracker|weletic-pos|weletic-free-product|\.env|node_modules/,
    );
    expect(files["shopify.app.toml"]).toContain(
      'extension_directories = ["extensions/*"]',
    );
    const report = JSON.parse(files["STAGING.json"]);
    expect(report.status).toBe("unowned_not_deployable");
    expect(report.extensionCount).toBe(10);
    for (const [path, hash] of Object.entries(report.sourceHashes)) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(root, "packages/shopify-app", path)))
          .digest("hex"),
      ).toBe(hash);
    }
  });

  it("uses only the public UI/lifecycle endpoints and thank-you target", () => {
    const files = buildPublicExtensionStage(root);
    for (const [path, text] of Object.entries(files)) {
      if (path.endsWith(".tsx")) {
        expect(text).toContain("https://loyalty-shopify-dev.weletic.com/api/");
        expect(text).not.toContain("https://shopify.weletic.com");
      }
    }
    expect(
      files["extensions/weletic-flow-lifecycle/shopify.extension.toml"],
    ).toContain(
      "https://loyalty-api-dev.weletic.com/api/shopify/flow/lifecycle",
    );
    const checkout =
      files["extensions/loyalty-checkout-slider/shopify.extension.toml"];
    expect(checkout).toContain("purchase.thank-you.block.render");
    expect(checkout).toContain('handle = "weletic-public-loyalty-thank-you"');
    expect(checkout).not.toContain("purchase.checkout.reductions");
    for (const locale of ["en.default", "ja", "vi"]) {
      const catalog = JSON.parse(
        files[`extensions/loyalty-checkout-slider/locales/${locale}.json`],
      );
      expect(catalog.balanceTitle).toBeTruthy();
      expect(catalog.balanceAvailable).toContain("{{points}}");
      expect(catalog.balancePending).toContain("{{points}}");
    }
    expect(
      Object.keys(
        JSON.parse(files["extensions/loyalty-checkout-slider/manifest.json"]),
      ),
    ).toEqual(["purchase.thank-you.block.render"]);
  });

  it("removes partner tracking and resolves every retained theme asset", () => {
    const files = buildPublicExtensionStage(root);
    const embed = files["extensions/weletic-analytics/blocks/app-embed.liquid"];
    expect(embed).not.toMatch(
      /weletic-tracker|enable_conversion_tracker|auto_apply_discounts|custom_domain|Partner Attribution/,
    );
    expect(embed).toContain("enable_loyalty_widget");
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith(".liquid")) continue;
      for (const match of text.matchAll(/'([^']+)'\s*\|\s*asset_url/g)) {
        expect(files).toHaveProperty(
          `extensions/weletic-analytics/assets/${match[1]}`,
        );
      }
    }
  });

  it("rejects changed source anchors instead of broad replacements", () => {
    const previewPath =
      "weletic-analytics/blocks/product-points-preview.liquid";
    const preview = readFileSync(
      join(root, "packages/shopify-app/extensions", previewPath),
      "utf8",
    );
    expect(transformPublicExtension(previewPath, preview)).toBe(preview);
    expect(() =>
      transformPublicExtension(
        previewPath,
        preview.replace("        —", "        100"),
      ),
    ).toThrow("Public staging source anchor changed");
    expect(() =>
      transformPublicExtension(previewPath, preview + preview),
    ).toThrow("Public staging source anchor changed");
    for (const assignment of [
      'uid="inherited"',
      "uid = 'inherited'",
      '"uid" = "inherited"',
      '"u\\u0069d" = "inherited"',
    ]) {
      const path = "weletic-referral-completed/shopify.extension.toml";
      const source = readFileSync(
        join(root, "packages/shopify-app/extensions", path),
        "utf8",
      );
      expect(() =>
        transformPublicExtension(path, source + "\n" + assignment),
      ).toThrow("Unreviewed extension manifest drift");
    }
    expect(() =>
      transformPublicExtension(
        "weletic-customer-account/src/CustomerAccountLoyalty.tsx",
        "different origin",
      ),
    ).toThrow();
    expect(() =>
      transformPublicExtension(
        "weletic-points-earned/shopify.extension.toml",
        'uid = "a"\nuid = "b"\n',
      ),
    ).toThrow();
    expect(() =>
      transformPublicExtension(
        "weletic-referral-completed/shopify.extension.toml",
        'uid = "unexpected"\n',
      ),
    ).toThrow();
    expect(() =>
      transformPublicExtension(
        "weletic-analytics/blocks/app-embed.liquid",
        "changed",
      ),
    ).toThrow();
  });

  it("creates a fresh private stage, refuses reuse and preserves custom source", () => {
    const custom = join(root, "packages/shopify-app/shopify.app.toml");
    const before = readFileSync(custom, "utf8");
    const destination = join(
      realpathSync(tmpdir()),
      `weletic-public-stage-test-${randomUUID()}`,
    );
    const result = writePublicExtensionStage(destination, root);
    created.push(destination);
    expect(result.status).toBe("unowned_not_deployable");
    expect(existsSync(join(destination, "STAGING.json"))).toBe(true);
    expect(() => writePublicExtensionStage(destination, root)).toThrow();
    expect(readFileSync(custom, "utf8")).toBe(before);
    expect(() =>
      writePublicExtensionStage(join(root, "do-not-create"), root),
    ).toThrow();
    expect(existsSync(join(root, "do-not-create"))).toBe(false);
  });
});
