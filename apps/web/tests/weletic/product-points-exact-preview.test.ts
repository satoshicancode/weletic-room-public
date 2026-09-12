/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const extension = path.resolve(
  __dirname,
  "../../../../packages/shopify-app/extensions/weletic-analytics",
);
const source = fs.readFileSync(
  path.join(extension, "assets/weletic-product-points.js"),
  "utf8",
);
const liquid = fs.readFileSync(
  path.join(extension, "blocks/product-points-preview.liquid"),
  "utf8",
);
const cleanups: Array<() => void> = [];

async function mount({
  price = "100000",
  currency = "JPY",
  rate = "2.5",
  locale = "en",
  status = 200,
  active = true,
}: {
  price?: string;
  currency?: string;
  rate?: unknown;
  locale?: string;
  status?: number;
  active?: boolean;
} = {}) {
  document.body.innerHTML =
    '<div class="weletic-product-points-container" data-shop="fixture.myshopify.com"><strong class="weletic-points-number">—</strong></div>';
  const container = document.querySelector(
    ".weletic-product-points-container",
  )!;
  container.setAttribute("data-current-price", price);
  container.setAttribute("data-currency", currency);
  container.setAttribute("data-locale", locale);
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation(
      (type: string, callback: any, options?: any) => {
        add(type, callback, options);
        cleanups.push(() =>
          target.removeEventListener(type, callback, options),
        );
      },
    );
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              program: { isActive: active, pointsPerCurrencyUnit: rate },
            },
          }),
          { status, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  new Function(source)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return document.querySelector(".weletic-points-number")!;
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("exact Shopify Liquid product points preview", () => {
  it.each([
    ["JPY", "100000", "2.5", "2,500"],
    ["KRW", "100000", "2.5", "2,500"],
    ["USD", "4800", "2.5", "120"],
    ["USD", "10000", "0.57", "57"],
    ["USD", "100", "0.9999", "0"],
    ["JPY", "100000", "1.2345", "1,234"],
    ["USD", "900719925474099300", "1", "9,007,199,254,740,993"],
    ["JPY", "0", "5", "0"],
  ])(
    "uses exact floor arithmetic for %s price=%s rate=%s",
    async (currency, price, rate, expected) => {
      expect((await mount({ currency, price, rate })).textContent).toBe(
        expected,
      );
    },
  );
  it.each(["ja", "vi", "en"])(
    "uses %s number formatting without Number coercion",
    async (locale) => {
      const result = await mount({
        price: "900719925474099300",
        rate: "1",
        locale,
      });
      expect(result.textContent).toBe(
        BigInt("9007199254740993").toLocaleString(locale),
      );
    },
  );
  it.each(["", "-1", "1.5", "12junk", "Infinity", "1e6"])(
    "does not invent a zero estimate for invalid price %s",
    async (price) => {
      expect((await mount({ price })).textContent).toBe("—");
    },
  );
  it.each([null, "", "0", "-1", "1e3", "1.00001", "9999999", true])(
    "fails closed for invalid rate %s",
    async (rate) => {
      expect((await mount({ rate })).textContent).toBe("—");
    },
  );
  it("accepts a zero-price variant change and rejects lossy numeric prices", async () => {
    const result = await mount();
    window.dispatchEvent(
      new CustomEvent("variant:change", { detail: { variant: { price: 0 } } }),
    );
    expect(result.textContent).toBe("0");
    window.dispatchEvent(
      new CustomEvent("variant:change", {
        detail: { variant: { price: Number.MAX_SAFE_INTEGER + 1 } },
      }),
    );
    expect(result.textContent).toBe("—");
  });
  it("does not accept an active-looking body on a failed HTTP response", async () => {
    expect((await mount({ status: 503 })).textContent).toBe("—");
  });
  it("does not estimate inactive programs", async () => {
    expect((await mount({ active: false })).textContent).toBe("—");
  });
  it("has no fabricated Liquid 1x initial estimate and escapes merchant copy", () => {
    expect(liquid).not.toMatch(/points_ratio|current_price_units|times:/);
    expect(liquid).toMatch(
      /class="weletic-points-number"[^>]*>\s*—\s*<\/strong>/,
    );
    expect(liquid).toContain("prefix_text | default: 'Earn up to' | escape");
    expect(liquid).toContain(
      "suffix_text | default: 'points with this purchase' | escape",
    );
  });
});
