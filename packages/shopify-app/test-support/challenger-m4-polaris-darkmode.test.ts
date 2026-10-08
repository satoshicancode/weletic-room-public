import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Milestone 4 Adversarial Challenger: Static Analysis, Dark Mode & App Bridge", () => {
  const shopifyAppDir = path.resolve(__dirname, "..");
  const loyaltyUiDir = path.join(shopifyAppDir, "app/ui/loyalty");
  const customersCssPath = path.join(shopifyAppDir, "app/customers.css");
  const routesDir = path.join(shopifyAppDir, "app/routes");
  const rootPath = path.join(shopifyAppDir, "app/root.tsx");

  it("asserts 0 occurrences of raw <input> across all loyalty UI components", () => {
    expect(fs.existsSync(loyaltyUiDir)).toBe(true);
    const files = fs
      .readdirSync(loyaltyUiDir)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; line: number; text: string }[] = [];
    const rawInputRegex = /<input[\s/>]/i;

    for (const file of files) {
      const fullPath = path.join(loyaltyUiDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        if (rawInputRegex.test(line)) {
          violations.push({ file, line: index + 1, text: line.trim() });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("asserts 0 hex color codes in customers.css and verifies tokenization", () => {
    expect(fs.existsSync(customersCssPath)).toBe(true);
    const cssContent = fs.readFileSync(customersCssPath, "utf-8");

    // Hex color pattern: #[0-9a-fA-F]{3,8}
    const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
    const matches = cssContent.match(hexRegex) ?? [];

    expect(matches).toEqual([]);
    expect(cssContent).toContain("var(--p-color-");
  });

  it("asserts presence and token validity of dark mode fallback media query in customers.css", () => {
    const cssContent = fs.readFileSync(customersCssPath, "utf-8");

    expect(cssContent).toContain("@media (prefers-color-scheme: dark)");
    expect(cssContent).toContain(":root:not(.p-theme-light)");

    // Required fundamental Polaris dark mode tokens
    const requiredTokens = [
      "--p-color-bg:",
      "--p-color-bg-surface:",
      "--p-color-text:",
      "--p-color-border:",
      "--p-color-border-focus:",
    ];

    for (const token of requiredTokens) {
      expect(cssContent).toContain(token);
    }
  });

  it("asserts dark mode fallback contrast ratio meets WCAG AA standards (>= 4.5:1)", () => {
    const cssContent = fs.readFileSync(customersCssPath, "utf-8");

    // Extract --p-color-bg-surface and --p-color-text
    const bgSurfaceMatch = cssContent.match(
      /--p-color-bg-surface:\s*rgba\((\d+),\s*(\d+),\s*(\d+)/,
    );
    const textMatch = cssContent.match(
      /--p-color-text:\s*rgba\((\d+),\s*(\d+),\s*(\d+)/,
    );

    expect(bgSurfaceMatch).not.toBeNull();
    expect(textMatch).not.toBeNull();

    const [r1, g1, b1] = [
      Number(bgSurfaceMatch![1]),
      Number(bgSurfaceMatch![2]),
      Number(bgSurfaceMatch![3]),
    ];
    const [r2, g2, b2] = [
      Number(textMatch![1]),
      Number(textMatch![2]),
      Number(textMatch![3]),
    ];

    const relativeLuminance = (r: number, g: number, b: number) => {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };

    const l1 = relativeLuminance(r1, g1, b1);
    const l2 = relativeLuminance(r2, g2, b2);
    const contrastRatio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    // WCAG AA for normal text requires at least 4.5:1
    expect(contrastRatio).toBeGreaterThan(4.5);
  });

  it("asserts App Bridge v4 NavMenu is configured in root.tsx with 15 destinations", () => {
    expect(fs.existsSync(rootPath)).toBe(true);
    const rootContent = fs.readFileSync(rootPath, "utf-8");

    expect(rootContent).toContain("<NavMenu>");
    expect(rootContent).toContain("@shopify/app-bridge-react");

    const expectedDestinations = [
      "/",
      "/customers",
      "/reviews",
      "/loyalty",
      "/earning-rules",
      "/loyalty-rewards",
      "/loyalty-referrals",
      "/loyalty-vip",
      "/loyalty-analytics",
      "/loyalty-communications",
      "/loyalty-imports",
      "/loyalty-nudges",
      "/loyalty-flow",
      "/appearance",
      "/settings",
    ];

    for (const dest of expectedDestinations) {
      expect(rootContent).toContain(`"${dest}"`);
    }
  });

  it("asserts all major merchant page routes render App Bridge TitleBar", () => {
    const pageRoutes = [
      "_index.tsx",
      "customers.tsx",
      "reviews.tsx",
      "loyalty.tsx",
      "earning-rules.tsx",
      "loyalty-rewards.tsx",
      "loyalty-referrals.tsx",
      "loyalty-vip.tsx",
      "loyalty-analytics.tsx",
      "loyalty-communications.tsx",
      "loyalty-nudges.tsx",
      "loyalty-flow.tsx",
      "loyalty-imports.tsx",
      "appearance.tsx",
      "settings.tsx",
      "staff-access.tsx",
    ];

    for (const route of pageRoutes) {
      const routePath = path.join(routesDir, route);
      expect(fs.existsSync(routePath)).toBe(true);
      const content = fs.readFileSync(routePath, "utf-8");
      // appearance.tsx delegates layout and TitleBar rendering to SettingsPage appearanceOnly
      if (route === "appearance.tsx") {
        expect(content).toContain("<SettingsPage appearanceOnly>");
      } else {
        expect(content).toMatch(/<TitleBar\b/);
      }
    }
  });

  it(
    "asserts zero inverted imports from packages/shopify-app into " +
      ["apps", "web"].join("/"),
    () => {
      const appDir = path.join(shopifyAppDir, "app");
      const forbiddenTarget = ["apps", "web"].join("/");
      const forbiddenRel = `../../${forbiddenTarget}`;
      const forbiddenDirect = `${forbiddenTarget}/`;

      const scanDir = (
        dir: string,
      ): { file: string; line: number; text: string }[] => {
        const violations: { file: string; line: number; text: string }[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            violations.push(...scanDir(full));
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            const lines = fs.readFileSync(full, "utf-8").split("\n");
            lines.forEach((line, idx) => {
              if (
                line.includes(forbiddenRel) ||
                line.includes(forbiddenDirect)
              ) {
                violations.push({
                  file: full,
                  line: idx + 1,
                  text: line.trim(),
                });
              }
            });
          }
        }
        return violations;
      };

      const violations = scanDir(appDir);
      expect(violations).toEqual([]);
    },
  );
});
