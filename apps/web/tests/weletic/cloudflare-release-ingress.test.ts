import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("Cloudflare release ingress policy and private-input CLI", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-release/ingress-policy.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(output).toContain("# fail 0");
}, 20_000);
