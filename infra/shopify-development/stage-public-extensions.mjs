import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = "shopify.extension.toml";
const locales = ["en.default.json", "ja.json", "vi.json"];
// Reviewed source manifests. Any identity/target/schema drift requires review,
// including valid TOML spellings that a textual UID remover would not recognize.
const manifestHashes = {
  "weletic-customer-account":
    "52fb9f173524f76a98a41557ce718d3c5953995eefd5dc788b22a68377c639fb",
  "weletic-customer-account-blocks":
    "564e99c7f2fb098c2c858f09a7e93172dfb400de2e3b620e21434ea069498848",
  "loyalty-checkout-slider":
    "d1c04ace4e7cd89a48edb7f44b1ee044511af5f7a48f5daa97b462df859fe7a0",
  "weletic-analytics":
    "84bd353a6b2bffed03c6ff225e522b5711c70211ac62315bf2bd6ab42902ebec",
  "weletic-points-earned":
    "4484a54f096440c8c9018cf30df2053a73e4cb92e922a9610c465427dfdd1979",
  "weletic-vip-tier-changed":
    "b0d30a12c998cd0c3249de285f46244860c006b898b66287d1d0e86de8a93e5c",
  "weletic-reward-redeemed":
    "e7914d7137ddf0db803842b222abe79b634125ae5c5bcc7c78b823264075bf6c",
  "weletic-points-expiring-soon":
    "9e17a24bf97a4c6e536968498d61458a49224f210034b55e2e5193864e95b707",
  "weletic-referral-completed":
    "cf97b614074a674886237c2a860e7cd397e6ea2e2aa402c33f36a463e15e82fb",
  "weletic-flow-lifecycle":
    "8aff6a7924f683cbcec06b44963e2509a92b2f159353e42fda959ea7dff018dc",
};
export const publicExtensionFiles = Object.freeze({
  "weletic-customer-account": [
    manifest,
    "manifest.json",
    "src/CustomerAccountLoyalty.tsx",
    ...locales.map((name) => `locales/${name}`),
  ],
  "weletic-customer-account-blocks": [
    manifest,
    "manifest.json",
    "src/CustomerAccountLoyaltyBlocks.tsx",
  ],
  "loyalty-checkout-slider": [
    manifest,
    "manifest.json",
    "src/ThankYou.tsx",
    ...locales.map((name) => `locales/${name}`),
  ],
  "weletic-analytics": [
    manifest,
    ...["app-embed", "loyalty-landing", "product-points-preview"].map(
      (name) => `blocks/${name}.liquid`,
    ),
    ...[
      "weletic-loyalty-styles.css",
      "weletic-loyalty-shared.js",
      "weletic-loyalty-widget.js",
      "weletic-loyalty-landing.js",
      "weletic-product-points.js",
    ].map((name) => `assets/${name}`),
    ...locales.map((name) => `locales/${name}`),
  ],
  ...Object.fromEntries(
    [
      "weletic-points-earned",
      "weletic-vip-tier-changed",
      "weletic-reward-redeemed",
      "weletic-points-expiring-soon",
      "weletic-referral-completed",
      "weletic-flow-lifecycle",
    ].map((name) => [name, [manifest]]),
  ),
});

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2)
    throw new Error("Public staging source anchor changed");
  return text.replace(before, after);
}

export function transformPublicExtension(path, source) {
  let text = source;
  if (path.endsWith(manifest)) {
    if (
      createHash("sha256").update(source).digest("hex") !==
      manifestHashes[path.split("/")[0]]
    )
      throw new Error("Unreviewed extension manifest drift");
    const matches = text.match(/^uid = "[^"\r\n]+"\r?\n/gm) || [];
    const expected = path.startsWith("weletic-referral-completed/") ? 0 : 1;
    if (matches.length !== expected)
      throw new Error("Unexpected source extension identity");
    text = text.replace(/^uid = "[^"\r\n]+"\r?\n/gm, "");
  }
  if (path === `loyalty-checkout-slider/${manifest}`) {
    text = replaceOnce(
      text,
      'name = "Weletic Loyalty Checkout Slider"',
      'name = "Weletic Loyalty Thank You"\nhandle = "weletic-public-loyalty-thank-you"',
    );
    text = replaceOnce(
      text,
      '[[targeting]]\nmodule = "./src/Checkout.tsx"\ntarget = "purchase.checkout.reductions.render-after"\n\n',
      "",
    );
  }
  if (path === "loyalty-checkout-slider/manifest.json") {
    const targets = JSON.parse(text);
    if (
      Object.keys(targets).sort().join() !==
      "purchase.checkout.reductions.render-after,purchase.thank-you.block.render"
    )
      throw new Error("Unexpected checkout target inventory");
    delete targets["purchase.checkout.reductions.render-after"];
    text = JSON.stringify(targets, null, 2) + "\n";
  }
  if (path.endsWith(".tsx")) {
    text = replaceOnce(
      text,
      "https://shopify.weletic.com/api/",
      `${PUBLIC_LOYALTY_APP_ORIGIN}/api/`,
    );
  }
  if (path === `weletic-flow-lifecycle/${manifest}`) {
    text = replaceOnce(
      text,
      "https://app.weletic.com/api/shopify/flow/lifecycle",
      `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/flow/lifecycle`,
    );
  }
  if (path === "weletic-analytics/blocks/app-embed.liquid") {
    const tracker = text.match(
      /{% if block.settings.enable_conversion_tracker %}[\s\S]*?{% endif %}\n\n/g,
    );
    if (tracker?.length !== 1)
      throw new Error("Unexpected partner tracker branch");
    text = replaceOnce(text, tracker[0], "");
    const schema = text.match(/{% schema %}\n([\s\S]*?)\n{% endschema %}/);
    if (!schema) throw new Error("Missing embed schema");
    const data = JSON.parse(schema[1]);
    const controls = data.settings.slice(0, 4);
    if (
      controls[0]?.content !== "Partner Attribution & Tracking" ||
      controls
        .slice(1)
        .map((item) => item.id)
        .join() !==
        "enable_conversion_tracker,auto_apply_discounts,custom_domain"
    )
      throw new Error("Unexpected partner controls");
    data.settings = data.settings.slice(4);
    text = replaceOnce(text, schema[1], JSON.stringify(data, null, 2));
  }
  if (path === "weletic-analytics/blocks/product-points-preview.liquid") {
    // Both identities now render an unknown estimate until the program loads.
    // Keep an exact anchor check so staging cannot silently accept source drift.
    const placeholder =
      '      <strong class="weletic-points-number" id="weletic-variant-points">\n        —\n      </strong>';
    text = replaceOnce(text, placeholder, placeholder);
  }
  return text;
}

/** Build in memory first. No credentials, dependency trees or unknown files copied. */
export function buildPublicExtensionStage(root = repository) {
  const sourceRoot = realpathSync(join(root, "packages/shopify-app"));
  const files = {};
  const hashes = {};
  const read = (path) => {
    const full = join(sourceRoot, path);
    if (!lstatSync(full).isFile() || realpathSync(full) !== full)
      throw new Error("Staging rejects symlinked source files");
    const content = readFileSync(full, "utf8");
    hashes[path] = createHash("sha256").update(content).digest("hex");
    return content;
  };
  for (const [extension, paths] of Object.entries(publicExtensionFiles)) {
    for (const path of paths) {
      const key = `${extension}/${path}`;
      files[`extensions/${key}`] = transformPublicExtension(
        key,
        read(`extensions/${key}`),
      );
    }
  }
  const config = read("shopify.app.loyalty-public.toml");
  files["shopify.app.toml"] = replaceOnce(
    config,
    "extension_directories = []",
    'extension_directories = ["extensions/*"]',
  );
  const pkg = JSON.parse(read("package.json"));
  files["package.json"] =
    JSON.stringify(
      {
        name: "weletic-public-extension-stage",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          ["@shopify/ui-extensions", "preact"].map((key) => [
            key,
            pkg.dependencies[key],
          ]),
        ),
      },
      null,
      2,
    ) + "\n";
  files["STAGING.json"] =
    JSON.stringify(
      {
        status: "unowned_not_deployable",
        sourceHashes: hashes,
        extensionCount: Object.keys(publicExtensionFiles).length,
        note: "No UIDs generated. Public-context identity reconciliation, build and live acceptance remain required.",
      },
      null,
      2,
    ) + "\n";
  return files;
}

/** Destination must be a new direct child of the canonical OS temporary directory. */
export function writePublicExtensionStage(destination, root = repository) {
  const target = resolve(destination);
  const source = realpathSync(root);
  const parent = realpathSync(dirname(target));
  const inside = relative(source, parent);
  if (
    parent !== realpathSync(tmpdir()) ||
    parent !== dirname(target) ||
    inside === "" ||
    (!inside.startsWith(`..${sep}`) && inside !== "..")
  )
    throw new Error(
      "Stage must be a fresh directory in the canonical OS temporary directory, outside the checkout",
    );
  const files = buildPublicExtensionStage(root);
  // Atomic refusal if any destination already exists; never overwrite a stage.
  mkdirSync(target, { mode: 0o700 });
  for (const [path, content] of Object.entries(files)) {
    const full = join(target, path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, content, { flag: "wx", mode: 0o600 });
  }
  return {
    destination: target,
    files: Object.keys(files).length,
    status: "unowned_not_deployable",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node stage-public-extensions.mjs <new-directory-outside-checkout>",
    );
  console.log(JSON.stringify(writePublicExtensionStage(process.argv[2])));
}
