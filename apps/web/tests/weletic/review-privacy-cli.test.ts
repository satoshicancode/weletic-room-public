import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const script = fileURLToPath(
  new URL("../../scripts/loyalty/inspect-review-privacy.ts", import.meta.url),
);
const failure =
  "Review privacy inspection failed; privately verify the exact store, generation, schema and key configuration.";

it.each(
  [
    [],
    ["--store", "private-store-sentinel"],
    ["--unknown", "private-argument-sentinel"],
    ["private-positional-sentinel"],
    [
      "--store",
      "private-store-sentinel",
      "--generation",
      "g1",
      "--sources",
      "--page-size",
      "101",
    ],
    [
      "--store",
      "private-store-sentinel",
      "--generation",
      "g1",
      "--max-pages",
      "1",
    ],
    [
      "--store",
      "private-store-sentinel",
      "--generation",
      "private-generation-sentinel",
    ],
  ].map((args) => ({ args })),
)(
  "fails closed in a real CLI process without leaking inputs: $args",
  ({ args }) => {
    const result = spawnSync(
      process.execPath,
      ["--import", require.resolve("tsx"), script, ...args],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          // Deliberately invalid, never a network destination or real credential.
          DATABASE_URL: "private-invalid-database-sentinel",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(failure);
  },
);
