import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("Cloudflare release ingress policy, guarded startup and private-input CLI", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/runtime-smoke.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/web-image.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/ingress-policy.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/start.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/shopify-image.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/shopify-smoke.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/loyalty-web.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(output).toContain("# fail 0");
}, 20_000);
