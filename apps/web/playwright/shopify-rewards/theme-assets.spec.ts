import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const assetsDir = path.resolve(
  __dirname,
  "../../../../packages/shopify-app/extensions/weletic-analytics/assets",
);
const sharedSource = fs.readFileSync(
  path.join(assetsDir, "weletic-loyalty-shared.js"),
  "utf8",
);
const widgetSource = fs.readFileSync(
  path.join(assetsDir, "weletic-loyalty-widget.js"),
  "utf8",
);
const stylesSource = fs.readFileSync(
  path.join(assetsDir, "weletic-loyalty-styles.css"),
  "utf8",
);

test("theme launcher uses real hidden CSS and survives Shopify section reloads idempotently", async ({
  page,
}) => {
  await page.route("https://store.example/**", async (route) => {
    if (route.request().url().includes("/apps/weletic/program?")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            program: { isActive: true },
            branding: { enableFloatingLauncher: true },
            currency: "USD",
            tiers: [],
            earningRules: [],
            rewards: [],
          },
        }),
      });
      return;
    }

    await route.fulfill({
      contentType: "text/html",
      body: '<section id="shopify-section-loyalty"><div data-weletic-loyalty-root data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div></section>',
    });
  });

  await page.goto("https://store.example/");
  await page.addStyleTag({ content: stylesSource });

  await page.evaluate(() => {
    const launcher = document.createElement("button");
    launcher.id = "hidden-css-probe";
    launcher.className = "weletic-launcher-btn";
    launcher.hidden = true;
    document.body.appendChild(launcher);
  });
  const cssProbe = page.locator("#hidden-css-probe");
  await expect(cssProbe).toHaveCSS("display", "none");
  await cssProbe.evaluate((element: HTMLButtonElement) => {
    element.hidden = false;
  });
  await expect(cssProbe).toHaveCSS("display", "flex");
  await cssProbe.evaluate((element) => element.remove());

  await page.addScriptTag({ content: sharedSource });
  await page.addScriptTag({ content: widgetSource });
  await page.addScriptTag({ content: widgetSource });

  const launcher = page.locator(".weletic-launcher-btn");
  await expect(launcher).toHaveCount(1);
  await expect(launcher).toBeVisible();

  await page.locator("#shopify-section-loyalty").evaluate((section) => {
    section.dispatchEvent(
      new Event("shopify:section:unload", { bubbles: true }),
    );
  });
  await expect(launcher).toHaveCount(0);
  await expect(page.locator(".weletic-modal-overlay")).toHaveCount(0);
  await expect(page.locator(".weletic-drawer")).toHaveCount(0);

  await page.locator("#shopify-section-loyalty").evaluate((section) => {
    section.innerHTML =
      '<div data-weletic-loyalty-root data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>';
    section.dispatchEvent(new Event("shopify:section:load", { bubbles: true }));
  });
  await expect(launcher).toHaveCount(1);
  await expect(launcher).toBeVisible();
});
