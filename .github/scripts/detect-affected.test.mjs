import assert from "node:assert/strict";
import test from "node:test";

import { classifyAffectedPaths } from "./detect-affected.mjs";

const noneAffected = {
  lint: false,
  shopify: false,
  unit: false,
  web: false,
};

test("documentation-only changes do not schedule code checks", () => {
  assert.deepEqual(
    classifyAffectedPaths(["docs/loyalty.md", "README.md"]),
    noneAffected,
  );
});

test("web changes schedule web validation and unit tests", () => {
  for (const file of ["apps/web/app/page.tsx", "apps/web/next.config.mjs"]) {
    assert.deepEqual(classifyAffectedPaths([file]), {
      lint: true,
      shopify: false,
      unit: true,
      web: true,
    });
  }
});

test("Shopify-only changes do not schedule the web suite", () => {
  for (const file of [
    "packages/shopify-app/app/routes/app.tsx",
    "packages/shopify-app/tsconfig.json",
  ]) {
    assert.deepEqual(classifyAffectedPaths([file]), {
      lint: false,
      shopify: true,
      unit: false,
      web: false,
    });
  }
});

test("Shopify trust-boundary changes schedule every check independently", () => {
  for (const file of [
    "apps/web/app/(ee)/api/shopify/flow/lifecycle/route.ts",
    "apps/web/app/(ee)/api/shopify/integration/webhook/route.ts",
    "apps/web/lib/weletic/shopify/webhook-request.ts",
    "apps/web/lib/weletic/shopify/webhook-signature.ts",
  ]) {
    assert.deepEqual(classifyAffectedPaths([file]), {
      lint: true,
      shopify: true,
      unit: true,
      web: true,
    });
  }
});

test("similarly named web directories retain targeted checks", () => {
  for (const file of [
    "apps/web/app/(ee)/api/shopify-other/route.ts",
    "apps/web/lib/weletic/shopify-other/helper.ts",
  ]) {
    assert.deepEqual(classifyAffectedPaths([file]), {
      lint: true,
      shopify: false,
      unit: true,
      web: true,
    });
  }
});

test("shared package changes conservatively validate both applications", () => {
  assert.deepEqual(classifyAffectedPaths(["packages/utils/src/index.ts"]), {
    lint: true,
    shopify: true,
    unit: true,
    web: true,
  });
});

test("cross-application changes schedule every fast check", () => {
  assert.deepEqual(
    classifyAffectedPaths([
      "apps/web/app/page.tsx",
      "packages/shopify-app/app/routes/app.tsx",
    ]),
    {
      lint: true,
      shopify: true,
      unit: true,
      web: true,
    },
  );
});

test("workflow and dependency changes run every fast check", () => {
  for (const file of [".github/workflows/quality.yaml", "pnpm-lock.yaml"]) {
    assert.deepEqual(classifyAffectedPaths([file]), {
      lint: true,
      shopify: true,
      unit: true,
      web: true,
    });
  }
});

test("forced runs validate every application", () => {
  assert.deepEqual(classifyAffectedPaths([], { forceAll: true }), {
    lint: true,
    shopify: true,
    unit: true,
    web: true,
  });
});
