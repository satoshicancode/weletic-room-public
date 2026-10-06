"use client";

import { AlertTriangle, Check, CheckCircle2, Copy, Info } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * 1688 Supplier Variant definition for size-run integrity check.
 */
export interface YamaxSupplierVariant {
  color: string;
  size: string; // "S", "M", "L", "XL"
  inStock: boolean;
}

export interface YamaxSizeRunValidationResult {
  valid: boolean;
  discontinuedColors: string[];
  eligibleVariants: YamaxSupplierVariant[];
  colorStatus: Record<
    string,
    {
      complete: boolean;
      availableSizes: string[];
      missingSizes: string[];
    }
  >;
}

/**
 * Validates that every imported color variant has a complete size run (S, M, L, XL).
 * Per Yamax standards: If any size is missing/sold out from the 1688 supplier,
 * the color is considered discontinued and MUST NOT be imported.
 */
export function validateYamaxSupplierSizeRun(
  variants: YamaxSupplierVariant[],
  requiredSizes: string[] = ["S", "M", "L", "XL"],
): YamaxSizeRunValidationResult {
  const colorMap = new Map<string, Set<string>>();
  const allColors = new Set<string>();

  for (const v of variants) {
    allColors.add(v.color);
    if (v.inStock) {
      if (!colorMap.has(v.color)) {
        colorMap.set(v.color, new Set());
      }
      colorMap.get(v.color)!.add(v.size);
    }
  }

  const discontinuedColors: string[] = [];
  const colorStatus: YamaxSizeRunValidationResult["colorStatus"] = {};

  for (const color of allColors) {
    const inStockSizes = colorMap.get(color) || new Set<string>();
    const availableSizes = requiredSizes.filter((s) => inStockSizes.has(s));
    const missingSizes = requiredSizes.filter((s) => !inStockSizes.has(s));
    const complete = missingSizes.length === 0;

    colorStatus[color] = {
      complete,
      availableSizes,
      missingSizes,
    };

    if (!complete) {
      discontinuedColors.push(color);
    }
  }

  const eligibleVariants = variants.filter(
    (v) => !discontinuedColors.includes(v.color) && v.inStock,
  );

  return {
    valid: discontinuedColors.length === 0,
    discontinuedColors,
    eligibleVariants,
    colorStatus,
  };
}

/**
 * Standard copywriting constants per Yamax activewear standards.
 */
export const YAMAX_UNDER_CHECKOUT = {
  shippingAndDelivery:
    "Free shipping on orders over ¥6,000. For orders under ¥6,000, a flat shipping rate of ¥800 applies. Delivered via air cargo in 3–7 business days with end-to-end tracking.",
  easyReturns:
    "We stand behind our craftsmanship. We accept returns within 30 days of delivery for any manufacturing or quality defects. Please ensure items are unworn and in original packaging.",
};

export interface YamaxHeroContent {
  tagline: string;
  bullet1Title: string;
  bullet1Desc: string;
  bullet2Title: string;
  bullet2Desc: string;
  bullet3Title: string;
  bullet3Desc: string;
}

export interface YamaxAccordionsContent {
  targetSports: string; // e.g. "Running & Pickleball"
  activitiesDescription: string; // e.g. "Engineered for intense marathon runs, pickleball tournaments, HIIT workouts, and everyday high-support fitness."
  fabricComposition: string; // e.g. "60% Premium Nylon, 40% Spandex (Yenergy™ Series)"
  fabricWeight: string; // e.g. "190g"
  washInstruction: string;
  dryInstruction: string;
  careInstruction: string;
  fitTip: string;
}

export const DEFAULT_YAMAX_HERO: YamaxHeroContent = {
  tagline:
    "Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric and 40% Spandex to contour your body while keeping you cool and dry.",
  bullet1Title: "Non-Slip Waistband",
  bullet1Desc:
    "High-tension composite waist design that gently compresses the tummy and stays securely in place without sliding down.",
  bullet2Title: "Flattering Glute Contours",
  bullet2Desc:
    "Elegant curved back seams designed to naturally lift, shape, and enhance your silhouette.",
  bullet3Title: "Second-Skin Support",
  bullet3Desc:
    "Ultra-lightweight Yenergy™ fabric with 40% high-stretch Spandex delivers high-impact hold with a weightless feel.",
};

export const DEFAULT_YAMAX_ACCORDIONS: YamaxAccordionsContent = {
  targetSports: "Running & Pickleball",
  activitiesDescription:
    "Engineered for high-impact running, competitive pickleball, tennis drills, HIIT circuits, and athletic strength conditioning.",
  fabricComposition: "60% Premium Nylon, 40% Spandex (Yenergy™ Series)",
  fabricWeight: "190g",
  washInstruction:
    "Machine wash cold with like colors on gentle cycle. Do not use fabric softeners.",
  dryInstruction: "Hang dry in shade or tumble dry low. Do not dry clean.",
  careInstruction: "Wash inside out to preserve fabric luster. Do not iron.",
  fitTip:
    "Fits true to size. If you are between sizes, we recommend sizing up for a more comfortable fit (all-day wear), or sizing down for extra compression (best for high-impact running).",
};

/**
 * Builds standard Shopify HTML for Hero Section.
 */
export function generateYamaxHeroHtml(hero: YamaxHeroContent): string {
  return `<p>${hero.tagline}</p>
<ul>
  <li><strong>${hero.bullet1Title}</strong>: ${hero.bullet1Desc}</li>
  <li><strong>${hero.bullet2Title}</strong>: ${hero.bullet2Desc}</li>
  <li><strong>${hero.bullet3Title}</strong>: ${hero.bullet3Desc}</li>
</ul>`;
}

/**
 * Builds standard responsive HTML table for Size & Fit accordion.
 * Features:
 * - position: sticky; left: 0; z-index: 1 on first column for mobile scrolling
 * - overflow-x: auto; max-width: 100% container
 * - Fit Tip at top
 * - How to Measure & Contact support link at bottom
 */
export function generateYamaxSizeGuideHtml(fitTip: string): string {
  return `<p><strong>Fit Tip:</strong> ${fitTip}</p>
<div style="overflow-x: auto; max-width: 100%; position: relative;">
  <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: center;">
    <thead>
      <tr style="border-bottom: 2px solid rgb(229, 229, 229); background-color: rgb(249, 249, 249);">
        <th style="padding: 10px; font-weight: 600; position: sticky; left: 0px; background-color: rgb(249, 249, 249); z-index: 1;">Size</th>
        <th style="padding: 10px; font-weight: 600;">Length</th>
        <th style="padding: 10px; font-weight: 600;">Flat Waist</th>
        <th style="padding: 10px; font-weight: 600;">Flat Hips</th>
        <th style="padding: 10px; font-weight: 600;">Recommended Waist</th>
        <th style="padding: 10px; font-weight: 600;">Recommended Hips</th>
      </tr>
    </thead>
    <tbody>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">S</td>
        <td style="padding: 10px;">84 cm</td>
        <td style="padding: 10px;">25 cm</td>
        <td style="padding: 10px;">33 cm</td>
        <td style="padding: 10px;">58 – 64 cm</td>
        <td style="padding: 10px;">80 – 86 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">M</td>
        <td style="padding: 10px;">86 cm</td>
        <td style="padding: 10px;">27 cm</td>
        <td style="padding: 10px;">35 cm</td>
        <td style="padding: 10px;">64 – 70 cm</td>
        <td style="padding: 10px;">86 – 92 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">L</td>
        <td style="padding: 10px;">88 cm</td>
        <td style="padding: 10px;">29 cm</td>
        <td style="padding: 10px;">37 cm</td>
        <td style="padding: 10px;">70 – 76 cm</td>
        <td style="padding: 10px;">92 – 98 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">XL</td>
        <td style="padding: 10px;">90 cm</td>
        <td style="padding: 10px;">31 cm</td>
        <td style="padding: 10px;">39 cm</td>
        <td style="padding: 10px;">76 – 82 cm</td>
        <td style="padding: 10px;">98 – 104 cm</td>
      </tr>
    </tbody>
  </table>
</div>
<p style="margin-top: 15px; font-size: 13px; color: #666;"><strong>How to Measure:</strong> Measure around the narrowest part of your waist and the fullest part of your hips, keeping the tape comfortably loose.</p>
<p>Need help? <a href="/pages/contact">Contact us</a> and we'll be happy to assist.</p>`;
}

/**
 * Builds Material & Care HTML using FLAT list (no nested bullets, per Shopify Metafield rules).
 */
export function generateYamaxMaterialCareHtml(
  accordions: YamaxAccordionsContent,
): string {
  return `<p><strong>Composition:</strong> ${accordions.fabricComposition}</p>
<p><strong>Fabric Weight:</strong> ${accordions.fabricWeight}</p>
<ul>
  <li><strong>Wash:</strong> ${accordions.washInstruction}</li>
  <li><strong>Dry:</strong> ${accordions.dryInstruction}</li>
  <li><strong>Care:</strong> ${accordions.careInstruction}</li>
</ul>`;
}

/**
 * Complete Yamax Product Description Editor & Standards Validator component.
 */
export function YamaxProductDescriptionEditor({
  initialHero = DEFAULT_YAMAX_HERO,
  initialAccordions = DEFAULT_YAMAX_ACCORDIONS,
}: {
  initialHero?: YamaxHeroContent;
  initialAccordions?: YamaxAccordionsContent;
}) {
  const [hero, setHero] = useState<YamaxHeroContent>(initialHero);
  const [accordions, setAccordions] =
    useState<YamaxAccordionsContent>(initialAccordions);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 1688 Supplier sample test state
  const [sampleVariants, setSampleVariants] = useState<YamaxSupplierVariant[]>([
    { color: "Black", size: "S", inStock: true },
    { color: "Black", size: "M", inStock: true },
    { color: "Black", size: "L", inStock: true },
    { color: "Black", size: "XL", inStock: true },
    { color: "Sage Green", size: "S", inStock: false }, // Discontinued!
    { color: "Sage Green", size: "M", inStock: true },
    { color: "Sage Green", size: "L", inStock: true },
    { color: "Sage Green", size: "XL", inStock: true },
    { color: "Navy", size: "S", inStock: true },
    { color: "Navy", size: "M", inStock: true },
    { color: "Navy", size: "L", inStock: true },
    { color: "Navy", size: "XL", inStock: true },
  ]);

  const validationResult = useMemo(
    () => validateYamaxSupplierSizeRun(sampleVariants),
    [sampleVariants],
  );

  const heroHtml = useMemo(() => generateYamaxHeroHtml(hero), [hero]);
  const sizeGuideHtml = useMemo(
    () => generateYamaxSizeGuideHtml(accordions.fitTip),
    [accordions.fitTip],
  );
  const materialCareHtml = useMemo(
    () => generateYamaxMaterialCareHtml(accordions),
    [accordions],
  );

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="shadow-xs space-y-8 rounded-2xl border border-neutral-200 bg-white p-6">
      <div>
        <h2 className="text-xl font-bold text-neutral-900">
          Yamax Activewear Product Package & Standards Editor
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Enforces Lululemon/Alo Yoga premium copywriting style, flat HTML
          metafields, responsive sticky size table, and 1688 supplier size-run
          completeness.
        </p>
      </div>

      {/* Section 1: 1688 Supplier Size Run Completeness Check */}
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50/50 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-neutral-700" />
            <h3 className="text-sm font-bold text-neutral-900">
              1688 Supplier Variant Sizing Completeness Rule
            </h3>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${
              validationResult.valid
                ? "bg-green-100 text-green-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {validationResult.valid ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> All Color Runs Complete
              </>
            ) : (
              <>
                <AlertTriangle className="h-3.5 w-3.5" /> Discontinued Runs
                Detected
              </>
            )}
          </span>
        </div>

        <p className="text-xs text-neutral-600">
          Rule: A color variant missing any standard size (S, M, L, XL) from the
          1688 supplier listing indicates end-of-production and cannot be
          restocked. Only complete size runs may be imported.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(validationResult.colorStatus).map(
            ([color, status]) => (
              <div
                key={color}
                className={`space-y-1.5 rounded-lg border p-3 text-xs ${
                  status.complete
                    ? "border-green-200 bg-green-50/60"
                    : "border-rose-200 bg-rose-50/60"
                }`}
              >
                <div className="flex items-center justify-between font-bold">
                  <span>{color}</span>
                  <span
                    className={
                      status.complete ? "text-green-700" : "text-rose-700"
                    }
                  >
                    {status.complete ? "Eligible" : "REJECTED (Discontinued)"}
                  </span>
                </div>
                <div className="text-neutral-500">
                  In stock: {status.availableSizes.join(", ") || "None"}
                </div>
                {!status.complete && (
                  <div className="font-semibold text-rose-600">
                    Missing: {status.missingSizes.join(", ")}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      </div>

      {/* Section 2: Hero Section (Tagline + 3 Bullets) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b pb-2">
          <h3 className="text-base font-bold text-neutral-900">
            1. Main Description & Hero Section
          </h3>
          <button
            type="button"
            onClick={() => copyToClipboard(heroHtml, "hero")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            {copiedKey === "hero" ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            Copy HTML
          </button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Editor Form */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-neutral-700">
                1-2 Sentence Tagline
              </label>
              <textarea
                value={hero.tagline}
                onChange={(e) => setHero({ ...hero, tagline: e.target.value })}
                rows={3}
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-700">
                Bullet 1
              </label>
              <input
                value={hero.bullet1Title}
                onChange={(e) =>
                  setHero({ ...hero, bullet1Title: e.target.value })
                }
                placeholder="Title"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs font-medium text-neutral-900 outline-none focus:border-neutral-500"
              />
              <input
                value={hero.bullet1Desc}
                onChange={(e) =>
                  setHero({ ...hero, bullet1Desc: e.target.value })
                }
                placeholder="Description"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-700">
                Bullet 2
              </label>
              <input
                value={hero.bullet2Title}
                onChange={(e) =>
                  setHero({ ...hero, bullet2Title: e.target.value })
                }
                placeholder="Title"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs font-medium text-neutral-900 outline-none focus:border-neutral-500"
              />
              <input
                value={hero.bullet2Desc}
                onChange={(e) =>
                  setHero({ ...hero, bullet2Desc: e.target.value })
                }
                placeholder="Description"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-700">
                Bullet 3
              </label>
              <input
                value={hero.bullet3Title}
                onChange={(e) =>
                  setHero({ ...hero, bullet3Title: e.target.value })
                }
                placeholder="Title"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs font-medium text-neutral-900 outline-none focus:border-neutral-500"
              />
              <input
                value={hero.bullet3Desc}
                onChange={(e) =>
                  setHero({ ...hero, bullet3Desc: e.target.value })
                }
                placeholder="Description"
                className="mt-1 w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
              />
            </div>
          </div>

          {/* Rich Text Preview */}
          <div className="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <span className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              Rich Text Preview
            </span>
            <p className="text-xs leading-relaxed text-neutral-800">
              {hero.tagline}
            </p>
            <ul className="list-disc space-y-1.5 pl-4 text-xs text-neutral-800">
              <li>
                <strong>{hero.bullet1Title}</strong>: {hero.bullet1Desc}
              </li>
              <li>
                <strong>{hero.bullet2Title}</strong>: {hero.bullet2Desc}
              </li>
              <li>
                <strong>{hero.bullet3Title}</strong>: {hero.bullet3Desc}
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Section 3: Under-Checkout Tabs */}
      <div className="space-y-4">
        <h3 className="border-b pb-2 text-base font-bold text-neutral-900">
          2. Under-Checkout Tabs (Mandatory Copy)
        </h3>
        <div className="grid gap-4 text-xs sm:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <span className="font-bold text-neutral-900">
              Shipping & Delivery
            </span>
            <p className="leading-relaxed text-neutral-700">
              {YAMAX_UNDER_CHECKOUT.shippingAndDelivery}
            </p>
          </div>
          <div className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <span className="font-bold text-neutral-900">
              30-Day Easy Returns
            </span>
            <p className="leading-relaxed text-neutral-700">
              {YAMAX_UNDER_CHECKOUT.easyReturns}
            </p>
          </div>
        </div>
      </div>

      {/* Section 4: Bottom Accordions */}
      <div className="space-y-6">
        <h3 className="border-b pb-2 text-base font-bold text-neutral-900">
          3. Bottom Accordion Tabs
        </h3>

        {/* Tab 1: Designed For */}
        <div className="space-y-2 rounded-xl border border-neutral-200 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-neutral-900">
              Accordion 1: Designed for [{accordions.targetSports}]
            </span>
          </div>
          <input
            value={accordions.targetSports}
            onChange={(e) =>
              setAccordions({ ...accordions, targetSports: e.target.value })
            }
            placeholder="Target Sports (e.g. Running & Pickleball)"
            className="w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
          />
          <textarea
            value={accordions.activitiesDescription}
            onChange={(e) =>
              setAccordions({
                ...accordions,
                activitiesDescription: e.target.value,
              })
            }
            placeholder="SEO keywords and related activities"
            rows={2}
            className="w-full rounded-lg border border-neutral-200 p-2 text-xs text-neutral-900 outline-none focus:border-neutral-500"
          />
        </div>

        {/* Tab 2: Size & Fit (Responsive sticky first column table) */}
        <div className="space-y-3 rounded-xl border border-neutral-200 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-neutral-900">
              Accordion 2: Size & Fit (Shopify Page Metafield)
            </span>
            <button
              type="button"
              onClick={() => copyToClipboard(sizeGuideHtml, "sizeGuide")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              {copiedKey === "sizeGuide" ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              Copy Table HTML
            </button>
          </div>
          <div
            className="rounded-lg border border-neutral-200 bg-white p-3"
            dangerouslySetInnerHTML={{ __html: sizeGuideHtml }}
          />
        </div>

        {/* Tab 3: Material & Care (Flat list, no nested bullets) */}
        <div className="space-y-3 rounded-xl border border-neutral-200 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-neutral-900">
              Accordion 3: Material & Care (Flat List Standard)
            </span>
            <button
              type="button"
              onClick={() => copyToClipboard(materialCareHtml, "materialCare")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              {copiedKey === "materialCare" ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              Copy Material HTML
            </button>
          </div>
          <div
            className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 text-xs"
            dangerouslySetInnerHTML={{ __html: materialCareHtml }}
          />
        </div>
      </div>
    </div>
  );
}
