/** @vitest-environment happy-dom */
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPublicExtensionStage } from "../../../../infra/shopify-development/stage-public-extensions.mjs";

const files = buildPublicExtensionStage(resolve(process.cwd(), "../.."));
const block =
  files["extensions/weletic-analytics/blocks/product-points-preview.liquid"];
const script =
  files["extensions/weletic-analytics/assets/weletic-product-points.js"];
const number = block.match(
  /<strong class="weletic-points-number"[^>]*>[\s\S]*?<\/strong>/,
)?.[0];

function mount() {
  // Actual staged numeric fragment; synthetic surrounding price/currency inputs.
  document.body.innerHTML = `<div class="weletic-product-points-container" data-current-price="4800" data-currency="USD" data-shop="synthetic.myshopify.com">${number}</div>`;
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("public product-points initial display", () => {
  it("has no invented estimate before script execution or when scripts are disabled", () => {
    expect(number).toBeDefined();
    expect(number).not.toMatch(/\{[{%]|points_ratio|current_price_units/);
    mount();
    expect(document.querySelector("strong")?.textContent?.trim()).toBe("—");
  });

  it("keeps the placeholder until the actual asset receives the base program rate", async () => {
    mount();
    let respond!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      ),
    );
    new Function(script)();
    expect(document.querySelector("strong")?.textContent?.trim()).toBe("—");
    respond(
      Response.json({
        data: { program: { isActive: true, pointsPerCurrencyUnit: "2.5" } },
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("strong")?.textContent).toBe("120"),
    );
  });

  it("keeps the placeholder on transport failure", async () => {
    mount();
    const transport = vi.fn().mockRejectedValue(new Error("synthetic failure"));
    vi.stubGlobal("fetch", transport);
    new Function(script)();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(document.querySelector("strong")?.textContent?.trim()).toBe("—");
  });
});
