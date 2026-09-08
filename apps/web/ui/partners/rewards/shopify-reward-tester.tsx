"use client";

import {
  previewShopifyEcommerceReward,
  type ShopifyRewardPreviewCustomer,
  type ShopifyRewardPreviewOrder,
} from "@/lib/weletic/commissions/shopify-reward-preview";
import {
  decimalToMinorUnits,
  formatMoney,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  normalizeShopifyRewardResourceId,
  sameShopifyRewardResourceId,
  type ShopifyEcommerceRewardConfig,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { Button } from "@dub/ui";
import { cn } from "@dub/utils";
import {
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RewardIconSquare } from "./reward-icon-square";
import { RewardSheetCard } from "./reward-sheet-card";

export interface ShopifyRewardTesterProduct {
  id: string;
  externalId: string;
  title: string;
  handle: string;
  collectionExternalIds: string[];
  variants: Array<{
    id: string;
    externalId: string;
    title: string;
    sku: string | null;
    shopPrice: string;
    shopCurrency: string;
  }>;
}

interface SampleLine {
  key: string;
  variantKey: string;
  unitAmount: string;
  quantity: string;
}

const inputClassName =
  "h-9 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";

const variantKeyFor = (productId: string, variantId: string) =>
  `${productId}:${variantId}`;

function availableCustomers(
  config: ShopifyEcommerceRewardConfig | null,
): Array<{ value: ShopifyRewardPreviewCustomer; label: string }> {
  if (config?.customerSegmentMode === "new_vs_returning") {
    return [
      { value: "returning", label: "Returning customer" },
      { value: "new", label: "New customer" },
    ];
  }
  if (config?.customerSegmentMode === "shopify_segment") {
    return [
      { value: "segment_non_member", label: "Outside selected segment" },
      { value: "segment_member", label: "Inside selected segment" },
    ];
  }
  return [{ value: "returning", label: "Any customer" }];
}

function ruleTitle(
  config: ShopifyEcommerceRewardConfig,
  source:
    | "default_group"
    | "collection"
    | "product"
    | "variant"
    | "subscription",
  sourceId: string | null,
) {
  if (source === "default_group") return "All products";
  if (source === "subscription") return "Subscription rule";
  const overrides =
    source === "variant"
      ? config.variantOverrides
      : source === "product"
        ? config.productOverrides
        : config.collectionOverrides;
  return (
    overrides.find((override) =>
      sameShopifyRewardResourceId(
        source === "variant"
          ? "ProductVariant"
          : source === "product"
            ? "Product"
            : "Collection",
        override.id,
        sourceId,
      ),
    )?.title ?? `${source[0].toUpperCase()}${source.slice(1)} override`
  );
}

function rateLabel({
  type,
  basisPoints,
  fixedAmount,
  currency,
}: {
  type: "percentage" | "fixed";
  basisPoints: number | null;
  fixedAmount: bigint | null;
  currency: string;
}) {
  if (type === "percentage") {
    return `${(basisPoints ?? 0) / 100}%`;
  }
  return formatMoney(
    { amount: fixedAmount ?? BigInt(0), currency: normalizeCurrency(currency) },
    "en",
  );
}

export function ShopifyRewardTester({
  config,
  products,
  accountingCurrency,
}: {
  config: ShopifyEcommerceRewardConfig | null;
  products?: ShopifyRewardTesterProduct[];
  accountingCurrency: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [customer, setCustomer] =
    useState<ShopifyRewardPreviewCustomer>("returning");
  const [order, setOrder] = useState<ShopifyRewardPreviewOrder>({
    kind: "one_time",
  });
  const [lines, setLines] = useState<SampleLine[]>([]);

  const customers = useMemo(() => availableCustomers(config), [config]);
  useEffect(() => {
    if (!customers.some(({ value }) => value === customer)) {
      setCustomer(customers[0].value);
    }
  }, [customer, customers]);

  const catalogVariants = useMemo(() => {
    const variants =
      products?.flatMap((product) =>
        product.variants.map((variant) => ({
          product,
          variant,
          key: variantKeyFor(product.id, variant.id),
          label: `${product.title} — ${variant.title}`,
        })),
      ) ?? [];
    const seen = new Set<string>();

    const deduplicated = variants.filter(({ variant }) => {
      const canonicalId =
        normalizeShopifyRewardResourceId(
          "ProductVariant",
          variant.externalId,
        ) ?? variant.externalId;
      if (seen.has(canonicalId)) return false;
      seen.add(canonicalId);
      return true;
    });

    const labelCounts = deduplicated.reduce(
      (counts, { label }) => counts.set(label, (counts.get(label) ?? 0) + 1),
      new Map<string, number>(),
    );

    return deduplicated.map((item) => {
      const canonicalId =
        normalizeShopifyRewardResourceId(
          "ProductVariant",
          item.variant.externalId,
        ) ?? item.variant.externalId;
      return {
        ...item,
        optionLabel:
          labelCounts.get(item.label) === 1
            ? item.label
            : `${item.label} · Shopify #${canonicalId.slice(-8)}`,
      };
    });
  }, [products]);

  const addLine = (variantKey: string) => {
    const selected = catalogVariants.find(({ key }) => key === variantKey);
    if (!selected) return;
    const sameCurrency =
      selected.variant.shopCurrency.toUpperCase() ===
      accountingCurrency.toUpperCase();
    setLines((current) => [
      ...current,
      {
        key: `${variantKey}-${Date.now()}-${current.length}`,
        variantKey,
        unitAmount: sameCurrency
          ? minorUnitsToDecimal(
              BigInt(selected.variant.shopPrice),
              accountingCurrency,
            )
          : "",
        quantity: "1",
      },
    ]);
  };

  const parsedLines = useMemo(
    () =>
      lines.map((sample) => {
        const selected = catalogVariants.find(
          ({ key }) => key === sample.variantKey,
        );
        if (!selected) return null;
        const quantity = Number(sample.quantity);
        try {
          const unitAmount = decimalToMinorUnits(
            sample.unitAmount,
            accountingCurrency,
          );
          if (
            unitAmount < BigInt(0) ||
            !Number.isInteger(quantity) ||
            quantity < 1
          ) {
            return null;
          }
          return {
            key: sample.key,
            title: selected.label,
            productId: selected.product.id,
            productExternalId: selected.product.externalId,
            variantId: selected.variant.id,
            variantExternalId: selected.variant.externalId,
            collectionExternalIds: selected.product.collectionExternalIds,
            unitAmount,
            quantity,
          };
        } catch {
          return null;
        }
      }),
    [accountingCurrency, catalogVariants, lines],
  );

  const preview = useMemo(() => {
    if (!config || parsedLines.some((line) => line === null)) return null;
    const completeLines = parsedLines.filter(
      (line): line is NonNullable<typeof line> => line !== null,
    );
    return previewShopifyEcommerceReward({
      rawConfig: config,
      accountingCurrency,
      customer,
      order,
      lines: completeLines,
    });
  }, [accountingCurrency, config, customer, order, parsedLines]);

  const updateLine = (key: string, patch: Partial<SampleLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const renewalValid =
    order.kind !== "renewal" ||
    (Number.isInteger(order.renewalNumber) && order.renewalNumber >= 1);

  return (
    <RewardSheetCard
      className="shrink-0"
      title={
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <RewardIconSquare icon={FlaskConical} />
            <div className="min-w-0">
              <p className="font-medium text-neutral-900">Test this reward</p>
              <p className="truncate text-xs font-normal text-neutral-500">
                Preview the commission for each cart item without saving.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            text={expanded ? "Hide" : "Test reward"}
            icon={
              expanded ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )
            }
            className="h-8 shrink-0 rounded-lg"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          />
        </div>
      }
      content={
        expanded ? (
          <div className="space-y-4" data-testid="shopify-reward-tester">
            {!config && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Fix the highlighted reward fields before testing.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-neutral-700">
                Customer
                <select
                  aria-label="Sample customer"
                  value={customer}
                  onChange={(event) =>
                    setCustomer(
                      event.target.value as ShopifyRewardPreviewCustomer,
                    )
                  }
                  className={inputClassName}
                >
                  {customers.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-neutral-700">
                Order
                <select
                  aria-label="Sample order type"
                  value={order.kind}
                  onChange={(event) => {
                    const kind = event.target
                      .value as ShopifyRewardPreviewOrder["kind"];
                    setOrder(
                      kind === "renewal"
                        ? { kind, renewalNumber: 1 }
                        : { kind },
                    );
                  }}
                  className={inputClassName}
                >
                  <option value="one_time">One-time order</option>
                  <option value="first_subscription">
                    First subscription order
                  </option>
                  <option value="renewal">Subscription renewal</option>
                </select>
              </label>
            </div>

            {order.kind === "renewal" && (
              <label className="flex max-w-48 flex-col gap-1.5 text-xs font-medium text-neutral-700">
                Renewal number
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={order.renewalNumber}
                  aria-label="Renewal number"
                  aria-invalid={!renewalValid || undefined}
                  aria-describedby={
                    renewalValid ? undefined : "sample-renewal-number-error"
                  }
                  onChange={(event) =>
                    setOrder({
                      kind: "renewal",
                      renewalNumber: Number(event.target.value),
                    })
                  }
                  className={cn(
                    inputClassName,
                    !renewalValid &&
                      "border-red-300 focus:border-red-500 focus:ring-red-500",
                  )}
                />
                {!renewalValid && (
                  <span
                    id="sample-renewal-number-error"
                    className="font-normal text-red-600"
                  >
                    Enter a whole number of at least 1.
                  </span>
                )}
              </label>
            )}

            <div className="space-y-2">
              {lines.map((sample, index) => {
                const selected = catalogVariants.find(
                  ({ key }) => key === sample.variantKey,
                );
                const result = preview?.lines[index];
                const amountValid = parsedLines[index] !== null;
                return (
                  <div
                    key={sample.key}
                    data-testid="shopify-reward-test-line"
                    className="rounded-lg border border-neutral-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-900">
                          {selected?.label ?? "Unavailable variant"}
                        </p>
                        <p className="mt-0.5 text-xs text-neutral-500">
                          {result && config
                            ? `${ruleTitle(config, result.source, result.sourceId)} · ${rateLabel({ ...result, currency: accountingCurrency })}`
                            : "Enter a valid price and quantity."}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${selected?.label ?? "sample item"}`}
                        onClick={() =>
                          setLines((current) =>
                            current.filter(({ key }) => key !== sample.key),
                          )
                        }
                        className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-500"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)] items-end gap-2">
                      <label className="flex min-w-0 flex-col gap-1 text-xs text-neutral-600">
                        Price ({accountingCurrency.toUpperCase()})
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={sample.unitAmount}
                          aria-invalid={!amountValid || undefined}
                          onChange={(event) =>
                            updateLine(sample.key, {
                              unitAmount: event.target.value,
                            })
                          }
                          className={cn(
                            inputClassName,
                            !amountValid &&
                              "border-red-300 focus:border-red-500 focus:ring-red-500",
                          )}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1 text-xs text-neutral-600">
                        Quantity
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={sample.quantity}
                          aria-invalid={!amountValid || undefined}
                          onChange={(event) =>
                            updateLine(sample.key, {
                              quantity: event.target.value,
                            })
                          }
                          className={cn(
                            inputClassName,
                            !amountValid &&
                              "border-red-300 focus:border-red-500 focus:ring-red-500",
                          )}
                        />
                      </label>
                      <div className="text-right">
                        <p className="text-xs text-neutral-500">Commission</p>
                        <p className="mt-1.5 text-sm font-semibold text-neutral-900">
                          {result
                            ? formatMoney(
                                {
                                  amount: result.commission,
                                  currency:
                                    normalizeCurrency(accountingCurrency),
                                },
                                "en",
                              )
                            : "—"}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {catalogVariants.length ? (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-700">
                Add a sample product
                <div className="relative">
                  <Plus className="pointer-events-none absolute left-3 top-2.5 size-4 text-neutral-400" />
                  <select
                    aria-label="Add a sample product"
                    value=""
                    onChange={(event) => {
                      addLine(event.target.value);
                      event.target.value = "";
                    }}
                    className={cn(inputClassName, "w-full pl-9")}
                  >
                    <option value="">Select a product variant…</option>
                    {catalogVariants.map(({ key, optionLabel }) => (
                      <option key={key} value={key}>
                        {optionLabel}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            ) : (
              <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-500">
                No synced Shopify product variants are available to test.
              </p>
            )}

            <div className="flex items-center justify-between border-t border-neutral-200 pt-3">
              <span className="text-sm font-medium text-neutral-700">
                Partner commission total
              </span>
              <strong
                data-testid="shopify-reward-test-total"
                className="text-base font-semibold text-neutral-900"
              >
                {preview
                  ? formatMoney(
                      {
                        amount: preview.totalCommission,
                        currency: normalizeCurrency(accountingCurrency),
                      },
                      "en",
                    )
                  : "—"}
              </strong>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              Uses editable sample prices in the accounting currency. It does
              not create an order or commission and excludes discounts, tax,
              currency conversion, refunds, and manual commission rules.
            </p>
          </div>
        ) : undefined
      }
    />
  );
}
