#!/usr/bin/env node
/**
 * Empirical Challenger Verification Harness for Milestone 4 (UI-01, UI-02, UI-03)
 * App Bridge v4, Navigation Invariants, TitleBar, Polaris UI & CSS Tokenization
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const SHOPIFY_APP_DIR = path.resolve(REPO_ROOT, "packages/shopify-app");
const APP_DIR = path.resolve(SHOPIFY_APP_DIR, "app");
const ROUTES_DIR = path.resolve(APP_DIR, "routes");
const UI_LOYALTY_DIR = path.resolve(APP_DIR, "ui/loyalty");
const CUSTOMERS_CSS = path.resolve(APP_DIR, "customers.css");
const ROOT_TSX = path.resolve(APP_DIR, "root.tsx");
const REVIEWS_TSX = path.resolve(ROUTES_DIR, "reviews.tsx");

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;
const failureLog = [];

function assert(condition, message) {
  totalChecks++;
  if (condition) {
    passedChecks++;
    console.log(`  [PASS] ${message}`);
  } else {
    failedChecks++;
    console.error(`  [FAIL] ${message}`);
    failureLog.push(message);
  }
}

console.log("\n=======================================================");
console.log("CHALLENGER AUDIT: MILESTONE 4 (App Bridge v4 & UI Invariants)");
console.log("=======================================================\n");

// ---------------------------------------------------------------------------
// 1. App Bridge v4 Root & Navigation Invariants
// ---------------------------------------------------------------------------
console.log("--- 1. Root & NavMenu Invariants (app/root.tsx) ---");

assert(fs.existsSync(ROOT_TSX), "app/root.tsx exists");
const rootContent = fs.readFileSync(ROOT_TSX, "utf-8");

assert(
  rootContent.includes('import { NavMenu } from "@shopify/app-bridge-react";'),
  "root.tsx imports NavMenu from @shopify/app-bridge-react",
);

assert(
  rootContent.includes('<NavMenu>'),
  "root.tsx renders <NavMenu> component",
);

assert(
  rootContent.includes('cdn.shopify.com/shopifycloud/app-bridge.js'),
  "root.tsx includes App Bridge v4 script tag in <head>",
);

assert(
  rootContent.includes('<meta name="shopify-api-key" content={apiKey} />'),
  "root.tsx declares shopify-api-key meta tag",
);

// Verify all 15 routes in navLinks
const expected15Routes = [
  { path: "/", rel: "home" },
  { path: "/customers" },
  { path: "/reviews" },
  { path: "/loyalty" },
  { path: "/earning-rules" },
  { path: "/loyalty-rewards" },
  { path: "/loyalty-referrals" },
  { path: "/loyalty-vip" },
  { path: "/loyalty-analytics" },
  { path: "/loyalty-communications" },
  { path: "/loyalty-imports" },
  { path: "/loyalty-nudges" },
  { path: "/loyalty-flow" },
  { path: "/appearance" },
  { path: "/settings" },
];

for (const route of expected15Routes) {
  const hasRoute = rootContent.includes(`to: "${route.path}"`);
  assert(hasRoute, `NavMenu declares route '${route.path}'`);
  if (route.rel) {
    const hasRel = rootContent.includes(`rel: "${route.rel}"`);
    assert(hasRel, `NavMenu route '${route.path}' has rel="${route.rel}"`);
  }
}

// Check localization in navLinks (en, ja, vi)
assert(
  rootContent.includes('en: "Overview"') &&
    rootContent.includes('ja: "概要"') &&
    rootContent.includes('vi: "Tổng quan"'),
  "NavMenu routes contain trilingual localization (en, ja, vi)",
);

// ---------------------------------------------------------------------------
// 2. TitleBar Verification Across Page Routes
// ---------------------------------------------------------------------------
console.log("\n--- 2. TitleBar Across Page Routes ---");

const pageRouteFiles = [
  { file: "_index.tsx", path: "/" },
  { file: "customers.tsx", path: "/customers" },
  { file: "reviews.tsx", path: "/reviews" },
  { file: "loyalty.tsx", path: "/loyalty" },
  { file: "earning-rules.tsx", path: "/earning-rules" },
  { file: "loyalty-rewards.tsx", path: "/loyalty-rewards" },
  { file: "loyalty-referrals.tsx", path: "/loyalty-referrals" },
  { file: "loyalty-vip.tsx", path: "/loyalty-vip" },
  { file: "loyalty-analytics.tsx", path: "/loyalty-analytics" },
  { file: "loyalty-communications.tsx", path: "/loyalty-communications" },
  { file: "loyalty-imports.tsx", path: "/loyalty-imports" },
  { file: "loyalty-nudges.tsx", path: "/loyalty-nudges" },
  { file: "loyalty-flow.tsx", path: "/loyalty-flow" },
  { file: "settings.tsx", path: "/settings" },
  { file: "appearance.tsx", path: "/appearance", delegatesTo: "settings.tsx" },
  { file: "staff-access.tsx", path: "/staff-access" },
];

for (const { file, path: routePath, delegatesTo } of pageRouteFiles) {
  const filePath = path.resolve(ROUTES_DIR, file);
  assert(fs.existsSync(filePath), `Route file '${file}' exists`);
  const content = fs.readFileSync(filePath, "utf-8");

  if (delegatesTo) {
    assert(
      content.includes(`import SettingsPage from "./settings"`) &&
        content.includes(`<SettingsPage appearanceOnly>`),
      `Route '${file}' delegates to '${delegatesTo}' with appearanceOnly=true`,
    );
  } else {
    assert(
      content.includes('import { TitleBar') || content.includes('TitleBar,'),
      `Route '${file}' imports TitleBar from @shopify/app-bridge-react`,
    );
    assert(
      content.includes('<TitleBar'),
      `Route '${file}' renders <TitleBar /> in JSX`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Navigation Guard in routes/reviews.tsx
// ---------------------------------------------------------------------------
console.log("\n--- 3. Navigation Guard in routes/reviews.tsx ---");

assert(fs.existsSync(REVIEWS_TSX), "app/routes/reviews.tsx exists");
const reviewsContent = fs.readFileSync(REVIEWS_TSX, "utf-8");

assert(
  reviewsContent.includes("dirtyTranslations.current.size === 0 ||"),
  "reviews.tsx guards discard via dirtyTranslations check",
);

assert(
  reviewsContent.includes("window.confirm(discardCopy.current)"),
  "reviews.tsx invokes window.confirm when dirty translations exist",
);

assert(
  reviewsContent.includes("beforeunload"),
  "reviews.tsx attaches beforeunload event listener to prevent tab close",
);

assert(
  reviewsContent.includes('<Link') &&
    reviewsContent.includes('to="/"') &&
    reviewsContent.includes('if (inFlight.current || !confirmDiscard())') &&
    reviewsContent.includes('event.preventDefault();'),
  "reviews.tsx home Link intercepts navigation and calls event.preventDefault()",
);

assert(
  reviewsContent.includes('shopify.toast?.show'),
  "reviews.tsx integrates App Bridge toast notifications",
);

// ---------------------------------------------------------------------------
// 4. UI-01: Zero Raw <input> in Loyalty Screens
// ---------------------------------------------------------------------------
console.log("\n--- 4. UI-01: Raw Input Elimination in Loyalty Screens ---");

function checkNoRawInput(dir) {
  const files = fs.readdirSync(dir);
  let rawInputCount = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) continue;
    if (!f.endsWith(".tsx")) continue;
    const code = fs.readFileSync(full, "utf-8");
    const matches = code.match(/<input\b/g);
    if (matches) {
      console.error(`    Found raw <input> in ${f}: ${matches.length} occurrences`);
      rawInputCount += matches.length;
    }
  }
  return rawInputCount;
}

const loyaltyRawInputs = checkNoRawInput(UI_LOYALTY_DIR);
assert(loyaltyRawInputs === 0, `0 raw <input> tags in app/ui/loyalty/ (actual: ${loyaltyRawInputs})`);

// ---------------------------------------------------------------------------
// 5. UI-03: Zero Hex Colors in customers.css
// ---------------------------------------------------------------------------
console.log("\n--- 5. UI-03: CSS Tokenization in customers.css ---");

assert(fs.existsSync(CUSTOMERS_CSS), "app/customers.css exists");
const cssContent = fs.readFileSync(CUSTOMERS_CSS, "utf-8");
const hexMatches = cssContent.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
assert(
  hexMatches.length === 0,
  `0 hex color codes in customers.css (actual: ${hexMatches.length})`,
);

assert(
  cssContent.includes("@media (prefers-color-scheme: dark)"),
  "customers.css defines dark mode media query fallback",
);

assert(
  cssContent.includes("var(--p-color-"),
  "customers.css maps utilities to Polaris CSS custom properties",
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n=======================================================");
console.log(`TOTAL CHECKS: ${totalChecks}`);
console.log(`PASSED:       ${passedChecks}`);
console.log(`FAILED:       ${failedChecks}`);
console.log("=======================================================\n");

if (failedChecks > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
