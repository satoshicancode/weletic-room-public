import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const script = fileURLToPath(
  new URL("../../scripts/loyalty/backfill-review-privacy.ts", import.meta.url),
);
const scope = [
  "--store",
  "private-store-sentinel",
  "--generation",
  "private-generation-sentinel",
];
it("rejects FIFO, symlink, oversized and permissive checkpoints without blocking", () => {
  const directory = mkdtempSync(join(tmpdir(), "privacy-checkpoint-negative-"));
  try {
    const fifo = join(directory, "fifo");
    execFileSync("mkfifo", [fifo]);
    const oversized = join(directory, "large.json");
    writeFileSync(oversized, "x".repeat(8193), { mode: 0o600 });
    const permissive = join(directory, "public.json");
    writeFileSync(permissive, "{}");
    chmodSync(permissive, 0o644);
    const symlink = join(directory, "link");
    symlinkSync(oversized, symlink);
    for (const checkpoint of [
      fifo,
      oversized,
      permissive,
      symlink,
      directory,
    ]) {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          script,
          ...scope,
          "--checkpoint",
          checkpoint,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DATABASE_URL: "private-invalid-database-sentinel",
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      expect(child.stderr).not.toContain(directory);
      expect(child.stderr).toContain("Review privacy backfill failed.");
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
it.each(
  [
    [],
    ["--unknown", "private-input"],
    scope,
    [...scope, "--apply"],
    [...scope, "--limit", "101"],
    [...scope, "--limit", "1.5"],
    [...scope, "--operator", "private@example.test"],
  ].map((args) => ({ args })),
)("rejects invalid/startup input without leakage: $args", ({ args }) => {
  const child = spawnSync(
    process.execPath,
    ["--import", require.resolve("tsx"), script, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: "private-invalid-database-sentinel",
      },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr.trim()).toBe(
    "Review privacy backfill failed. Some owners may have committed; inspect private audit evidence and retry from the previous checkpoint with a new output path. No readiness is implied.",
  );
});
