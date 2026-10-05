#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const TARGET_DIR = path.resolve(REPO_ROOT, "packages/shopify-app");
const EXCLUDED_DIRS = new Set(["node_modules", "build", ".turbo", ".git"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

const violations = [];

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  const relPath = path.relative(REPO_ROOT, filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    // Detect any relative or direct path reference into apps/web
    if (line.includes("apps/web")) {
      violations.push({
        file: relPath,
        line: index + 1,
        content: line.trim(),
      });
    }
  });
}

console.log(`[PKG-01] Auditing ${TARGET_DIR} for inverted imports into apps/web...`);
scanDirectory(TARGET_DIR);

if (violations.length === 0) {
  console.log("✅ [PKG-01 PASS] Verified: Exactly 0 inverted imports from packages/shopify-app into apps/web.");
  process.exit(0);
} else {
  console.error(`❌ [PKG-01 FAIL] Found ${violations.length} inverted references to apps/web across ${new Set(violations.map(v => v.file)).size} files:\n`);
  violations.forEach(({ file, line, content }) => {
    console.error(`  ${file}:${line} -> ${content}`);
  });
  console.error(`\nTotal violations: ${violations.length}. All imports must resolve via @weletic/contracts or local package files.`);
  process.exit(1);
}
