import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_CHECK_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
]);

const FULL_CHECK_PREFIXES = [".github/workflows/", ".github/scripts/"];
const CODE_FILE_PATTERN = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
const CONFIG_FILE_PATTERN =
  /(?:^|\/)(?:eslint|next|playwright|prettier|tsconfig|vite|vitest)[^/]*\.(?:js|json|mjs|ts)$/;

export function classifyAffectedPaths(paths, { forceAll = false } = {}) {
  const affected = {
    lint: false,
    shopify: false,
    unit: false,
    web: false,
  };

  if (forceAll) {
    return Object.fromEntries(Object.keys(affected).map((key) => [key, true]));
  }

  for (const rawPath of paths) {
    const file = rawPath.trim();

    if (!file) {
      continue;
    }

    if (file.startsWith("apps/web/")) {
      affected.lint = true;
      affected.unit = true;
      affected.web = true;
      continue;
    }

    if (file.startsWith("packages/shopify-app/")) {
      affected.shopify = true;
      continue;
    }

    if (
      FULL_CHECK_FILES.has(file) ||
      FULL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      file.startsWith("scripts/") ||
      CONFIG_FILE_PATTERN.test(file)
    ) {
      affected.lint = true;
      affected.shopify = true;
      affected.unit = true;
      affected.web = true;
      continue;
    }

    if (file.startsWith("packages/")) {
      affected.lint = true;
      affected.shopify = true;
      affected.unit = true;
      affected.web = true;
      continue;
    }

    if (CODE_FILE_PATTERN.test(file)) {
      affected.lint = true;
      affected.shopify = true;
      affected.unit = true;
      affected.web = true;
    }
  }

  return affected;
}

function readChangedPaths() {
  if (process.env.CI_FORCE_ALL === "true") {
    return { forceAll: true, paths: [] };
  }

  const base = process.env.CI_BASE_SHA;
  const head = process.env.CI_HEAD_SHA || "HEAD";
  const diffMode = process.env.CI_DIFF_MODE === "direct" ? ".." : "...";

  if (!base || /^0+$/.test(base)) {
    return { forceAll: true, paths: [] };
  }

  const output = execFileSync(
    "git",
    ["diff", "--name-only", `${base}${diffMode}${head}`],
    {
      encoding: "utf8",
    },
  );

  return {
    forceAll: false,
    paths: output.split("\n").filter(Boolean),
  };
}

function writeGitHubOutputs(affected) {
  const lines = Object.entries(affected).map(
    ([key, value]) => `${key}=${value}`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }

  console.log(lines.join("\n"));
}

function main() {
  const { forceAll, paths } = readChangedPaths();
  const affected = classifyAffectedPaths(paths, { forceAll });

  console.log(`Detected ${paths.length} changed path(s).`);
  writeGitHubOutputs(affected);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
