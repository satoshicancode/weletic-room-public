import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Milestone 1 (M1): Storefront DOM PII Purge Verification", () => {
  const liquidPath = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions/weletic-analytics/blocks/app-embed.liquid",
  );
  const widgetJsPath = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions/weletic-analytics/assets/weletic-loyalty-widget.js",
  );

  it("ensures app-embed.liquid contains zero cleartext customer PII attributes", () => {
    const content = fs.readFileSync(liquidPath, "utf-8");

    expect(content).not.toContain("data-customer-email");
    expect(content).not.toContain("data-customer-first-name");
    expect(content).not.toContain("data-customer-last-name");
    expect(content).not.toContain("data-customer-phone");

    // Operational attributes must be retained
    expect(content).toContain(
      'id="weletic-loyalty-root-{{ block.id | escape }}"',
    );
    expect(content).toContain("data-weletic-loyalty-root");
    expect(content).toContain(
      'data-weletic-instance-id="{{ block.id | escape }}"',
    );
    expect(content).toContain("data-shop=");
    expect(content).not.toContain("data-customer-id=");
  });

  it("ensures weletic-loyalty-widget.js does not read PII from DOM attributes", () => {
    const jsContent = fs.readFileSync(widgetJsPath, "utf-8");

    expect(jsContent).not.toContain('root.getAttribute("data-customer-email")');
    expect(jsContent).not.toContain(
      'root.getAttribute("data-customer-first-name")',
    );
    expect(jsContent).not.toContain(
      'root.getAttribute("data-customer-last-name")',
    );
  });
});
