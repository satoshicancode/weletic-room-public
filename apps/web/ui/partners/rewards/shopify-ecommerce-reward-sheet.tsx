"use client";

import { deleteRewardAction } from "@/lib/actions/partners/delete-reward";
import { upsertShopifyEcommerceRewardAction } from "@/lib/actions/partners/upsert-shopify-reward";
import { mutatePrefix } from "@/lib/swr/mutate";
import useGroup from "@/lib/swr/use-group";
import useProgram from "@/lib/swr/use-program";
import useWorkspace from "@/lib/swr/use-workspace";
import { RewardProps } from "@/lib/types";
import {
  getShopifyRewardLifecycleMode,
  isValidShopifyRewardRateDraft,
  parseShopifyRecurringOrderCountDraft,
  retargetShopifyRewardOverrideDraft,
  serializeShopifyEcommerceRewardDraft,
  ShopifyEcommerceRewardDraft,
  ShopifyRewardCollectionOverrideDraft,
  ShopifyRewardLifecycleMode,
  ShopifyRewardOverrideDraft,
  ShopifyRewardProductOverrideDraft,
  ShopifyRewardSegmentDraft,
  ShopifyRewardVariantOverrideDraft,
  toShopifyCollectionOverrideDraft,
  toShopifyProductOverrideDraft,
  toShopifyRewardDateTimeDraft,
  toShopifyRewardRateDraft,
  toShopifyVariantOverrideDraft,
  validateShopifyEcommerceRewardDraft,
} from "@/lib/weletic/commissions/shopify-reward-form";
import {
  sameShopifyRewardResourceId,
  SHOPIFY_CUSTOMER_SEGMENT_MODES,
  SHOPIFY_SUBSCRIPTION_COMMISSION_MODES,
  ShopifyEcommerceRewardConfig,
  ShopifyEcommerceRewardConfigSchema,
  ShopifySubscriptionCommissionMode,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { Shopify } from "@/ui/guides/icons/shopify";
import { X } from "@/ui/shared/icons";
import {
  ArrowTurnRight2,
  Button,
  MoneyBills2,
  Popover,
  Sheet,
  useRouterStuff,
} from "@dub/ui";
import { cn, fetcher, pluralize } from "@dub/utils";
import {
  Box,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CircleHelp,
  Layers,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";
import {
  InlineBadgePopover,
  InlineBadgePopoverContext,
  InlineBadgePopoverMenu,
} from "../../shared/inline-badge-popover";
import { RewardIconSquare } from "./reward-icon-square";
import { RewardConnectorLine, RewardSheetCard } from "./reward-sheet-card";
import {
  ShopifyRewardTester,
  type ShopifyRewardTesterProduct,
} from "./shopify-reward-tester";

interface ShopifyCollectionItem {
  id: string;
  title: string;
  handle: string;
  productsCount?: number;
}

type ShopifyProductItem = ShopifyRewardTesterProduct;

interface ShopifySegmentItem {
  id: string;
  name: string;
}

interface ShopifyVariantItem {
  id: string;
  title: string;
  description?: string;
}

interface ShopifyEcommerceRewardSheetProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  reward?: RewardProps | null;
}

type CustomerSegmentMode = ShopifyEcommerceRewardConfig["customerSegmentMode"];
type RateType = ShopifyEcommerceRewardConfig["baseRateType"];
type OverrideRateField = "returningRate" | "newRate" | "segmentRate";
type AddConditionScope = "variant" | "product" | "collection";

const SHOPIFY_REWARD_LIFECYCLE_MODES = [
  {
    value: "draft",
    label: "Draft",
    description: "Save the configuration without paying commission.",
  },
  {
    value: "active",
    label: "Active now",
    description: "Pay commission immediately with no end date.",
  },
  {
    value: "scheduled",
    label: "Scheduled",
    description: "Pay commission only during a configured date window.",
  },
] as const;

const getShopifyResourceType = (scope: AddConditionScope) =>
  scope === "variant"
    ? ("ProductVariant" as const)
    : scope === "product"
      ? ("Product" as const)
      : ("Collection" as const);

const sameOverrideTarget = (
  scope: AddConditionScope,
  left?: string | null,
  right?: string | null,
) => sameShopifyRewardResourceId(getShopifyResourceType(scope), left, right);

const getScopeLabel = (scope: AddConditionScope) =>
  scope === "variant"
    ? "Variant"
    : scope === "product"
      ? "Product"
      : "Collection";

const flattenShopifyVariants = (
  products?: ShopifyProductItem[],
): ShopifyVariantItem[] | undefined =>
  products?.flatMap((product) =>
    product.variants.map((variant) => ({
      id: variant.externalId || variant.id,
      title: `${product.title} — ${variant.title}`,
      description: variant.sku
        ? `SKU: ${variant.sku}`
        : product.handle
          ? `/${product.handle}`
          : undefined,
    })),
  );

const mutateRewardConfiguration = async ({
  programId,
  groupIdentifiers,
}: {
  programId?: string | null;
  groupIdentifiers: Array<string | null | undefined>;
}) => {
  const groupPaths = groupIdentifiers
    .filter((identifier): identifier is string => Boolean(identifier))
    .map((identifier) => `/api/groups/${encodeURIComponent(identifier)}`);
  const programPath = programId
    ? `/api/programs/${encodeURIComponent(programId)}`
    : null;

  await Promise.all([
    mutatePrefix([
      "/api/groups",
      "/api/programs",
      "/api/partners",
      "/api/rewards",
    ]),
    mutate(
      (key) => {
        if (typeof key !== "string") return false;
        const pathname = key.split("?")[0];
        return (
          (programPath !== null && pathname === programPath) ||
          groupPaths.includes(pathname)
        );
      },
      undefined,
      { revalidate: true },
    ),
  ]);
};

const getSubscriptionDisplayText = (mode: ShopifySubscriptionCommissionMode) =>
  mode === "first_sale"
    ? "the first sale only"
    : mode === "every_recurring_order"
      ? "the first sale and every recurring order"
      : "the first sale and a limited number of renewals";

function RateBadge({
  value,
  onChange,
  suffix,
  label,
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  suffix: string;
  label: string;
  errorId?: string;
}) {
  const valid = isValidShopifyRewardRateDraft(value);
  const displayValue = valid
    ? suffix === "%"
      ? `${value}%`
      : `${value} ${suffix}`
    : "amount";

  return (
    <InlineBadgePopover text={displayValue} invalid={!valid}>
      <RateInput
        value={value}
        onChange={onChange}
        suffix={suffix}
        label={label}
        invalid={!valid}
        errorId={errorId}
      />
    </InlineBadgePopover>
  );
}

function RateInput({
  value,
  onChange,
  suffix,
  label,
  invalid,
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  suffix: string;
  label: string;
  invalid: boolean;
  errorId?: string;
}) {
  const { setIsOpen } = useContext(InlineBadgePopoverContext);

  return (
    <label className="relative flex w-36 items-center rounded-md border border-neutral-300 bg-white shadow-sm focus-within:border-neutral-500 focus-within:ring-1 focus-within:ring-neutral-500">
      <span className="sr-only">{label}</span>
      <input
        type="number"
        min="0"
        max="100"
        step="0.5"
        inputMode="decimal"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setIsOpen(false);
          }
        }}
        className="block min-w-0 grow rounded-md border-none px-2 py-1 pr-12 text-sm text-neutral-900 focus:outline-none focus:ring-0"
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-xs text-neutral-400">
        {suffix}
      </span>
    </label>
  );
}

function RecurringOrderCountBadge({
  value,
  onChange,
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  errorId?: string;
}) {
  const parsed = parseShopifyRecurringOrderCountDraft(value);

  return (
    <InlineBadgePopover
      text={
        parsed === null
          ? "number of renewals"
          : `${parsed} ${pluralize("renewal", parsed)}`
      }
      invalid={parsed === null}
    >
      <RecurringOrderCountInput
        value={value}
        onChange={onChange}
        invalid={parsed === null}
        errorId={errorId}
      />
    </InlineBadgePopover>
  );
}

function RecurringOrderCountInput({
  value,
  onChange,
  invalid,
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  errorId?: string;
}) {
  const { setIsOpen } = useContext(InlineBadgePopoverContext);

  return (
    <label className="relative flex w-40 items-center rounded-md border border-neutral-300 bg-white shadow-sm focus-within:border-neutral-500 focus-within:ring-1 focus-within:ring-neutral-500">
      <span className="sr-only">Number of recurring orders</span>
      <input
        type="number"
        min="1"
        step="1"
        inputMode="numeric"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setIsOpen(false);
          }
        }}
        className="block w-16 rounded-md border-none px-2 py-1 text-sm text-neutral-900 focus:outline-none focus:ring-0"
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-xs text-neutral-400">
        renewals
      </span>
    </label>
  );
}

function OverrideScopePickerMenu({
  currentScope,
  override,
  variants,
  products,
  collections,
  variantOverrides,
  productOverrides,
  collectionOverrides,
  onConditionChange,
}: {
  currentScope: AddConditionScope;
  override: ShopifyRewardOverrideDraft;
  variants?: ShopifyVariantItem[];
  products?: ShopifyProductItem[];
  collections?: ShopifyCollectionItem[];
  variantOverrides: ShopifyRewardVariantOverrideDraft[];
  productOverrides: ShopifyRewardProductOverrideDraft[];
  collectionOverrides: ShopifyRewardCollectionOverrideDraft[];
  onConditionChange: (
    scope: AddConditionScope,
    id: string,
    title: string,
  ) => void;
}) {
  const { isOpen } = useContext(InlineBadgePopoverContext);
  const [pickerScope, setPickerScope] = useState<AddConditionScope | null>(
    null,
  );

  useEffect(() => {
    if (!isOpen) setPickerScope(null);
  }, [isOpen]);

  if (pickerScope === null) {
    return (
      <InlineBadgePopoverMenu
        selectedValue={currentScope}
        items={[
          {
            icon: <Box className="size-4 text-neutral-500" />,
            text: "Variant",
            description: "Match one product variant.",
            value: "variant" as const,
            preventClose: true,
          },
          {
            icon: <Package className="size-4 text-neutral-500" />,
            text: "Product",
            description: "Match one product.",
            value: "product" as const,
            preventClose: true,
          },
          {
            icon: <Layers className="size-4 text-neutral-500" />,
            text: "Collection",
            description: "Match one collection.",
            value: "collection" as const,
            preventClose: true,
          },
        ]}
        onSelect={setPickerScope}
      />
    );
  }

  const targetItems =
    pickerScope === "variant"
      ? variants?.map((variant) => ({
          text: variant.title,
          description: variant.description,
          value: variant.id,
          disabled: variantOverrides.some(
            (item) =>
              sameOverrideTarget("variant", item.id, variant.id) &&
              !(
                currentScope === "variant" &&
                sameOverrideTarget("variant", item.id, override.id)
              ),
          ),
        }))
      : pickerScope === "product"
        ? products?.map((product) => {
            const value = product.externalId || product.id;
            return {
              text: product.title,
              description: product.handle ? `/${product.handle}` : undefined,
              value,
              disabled: productOverrides.some(
                (item) =>
                  sameOverrideTarget("product", item.id, value) &&
                  !(
                    currentScope === "product" &&
                    sameOverrideTarget("product", item.id, override.id)
                  ),
              ),
            };
          })
        : collections?.map((collection) => ({
            text: collection.title,
            description: collection.handle
              ? `/${collection.handle}`
              : undefined,
            value: collection.id,
            disabled: collectionOverrides.some(
              (item) =>
                sameOverrideTarget("collection", item.id, collection.id) &&
                !(
                  currentScope === "collection" &&
                  sameOverrideTarget("collection", item.id, override.id)
                ),
            ),
          }));

  return (
    <div className="w-72">
      <button
        type="button"
        onClick={() => setPickerScope(null)}
        className="mb-1 flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-100"
      >
        <ChevronLeft className="size-4" />
        Choose {pickerScope}
      </button>
      {targetItems === undefined ? (
        <p className="px-3 py-6 text-center text-xs text-neutral-500">
          Loading{" "}
          {pickerScope === "variant"
            ? "variants"
            : pickerScope === "product"
              ? "products"
              : "collections"}
          …
        </p>
      ) : (
        <InlineBadgePopoverMenu
          search
          selectedValue={pickerScope === currentScope ? override.id : undefined}
          items={targetItems}
          onSelect={(value) => {
            if (pickerScope === "variant") {
              const variant = variants?.find((item) => item.id === value);
              if (variant) {
                onConditionChange("variant", value, variant.title);
              }
            } else if (pickerScope === "product") {
              const product = products?.find(
                (item) => (item.externalId || item.id) === value,
              );
              if (product) {
                onConditionChange("product", value, product.title);
              }
            } else {
              const collection = collections?.find((item) => item.id === value);
              if (collection) {
                onConditionChange("collection", value, collection.title);
              }
            }
          }}
        />
      )}
    </div>
  );
}

function HelpPopover({
  content,
  label,
  accessibleLabel,
}: {
  content: string;
  label?: string;
  accessibleLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover
      openPopover={isOpen}
      setOpenPopover={setIsOpen}
      align="end"
      content={
        <div className="w-72 p-3 text-xs leading-5 text-neutral-600">
          {content}
        </div>
      }
    >
      <button
        type="button"
        aria-label={accessibleLabel}
        onClick={() => setIsOpen(true)}
        className={cn(
          "shrink-0 rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700",
          label
            ? "flex items-center gap-1.5 px-2 py-1 text-xs font-medium"
            : "p-1.5 text-neutral-400",
        )}
      >
        <CircleHelp className={label ? "size-3.5" : "size-4"} />
        {label}
      </button>
    </Popover>
  );
}

function OverrideConditionBlock({
  index,
  count,
  scope,
  override,
  variants,
  products,
  collections,
  variantOverrides,
  productOverrides,
  collectionOverrides,
  segmentMode,
  segmentName,
  baseNewRate,
  segmentRate,
  rateSuffix,
  onConditionChange,
  onRateChange,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  index: number;
  count: number;
  scope: AddConditionScope;
  override: ShopifyRewardOverrideDraft;
  variants?: ShopifyVariantItem[];
  products?: ShopifyProductItem[];
  collections?: ShopifyCollectionItem[];
  variantOverrides: ShopifyRewardVariantOverrideDraft[];
  productOverrides: ShopifyRewardProductOverrideDraft[];
  collectionOverrides: ShopifyRewardCollectionOverrideDraft[];
  segmentMode: CustomerSegmentMode;
  segmentName?: string;
  baseNewRate: string;
  segmentRate?: string;
  rateSuffix: string;
  onConditionChange: (
    scope: AddConditionScope,
    id: string,
    title: string,
  ) => void;
  onRateChange: (field: OverrideRateField, value: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
}) {
  const newCustomerRate = override.newRate ?? baseNewRate;
  const segmentMemberRate = override.segmentRate ?? segmentRate ?? baseNewRate;
  const hasInvalidRates =
    !isValidShopifyRewardRateDraft(override.returningRate) ||
    (segmentMode === "new_vs_returning" &&
      !isValidShopifyRewardRateDraft(newCustomerRate)) ||
    (segmentMode === "shopify_segment" &&
      !isValidShopifyRewardRateDraft(segmentMemberRate));
  const errorId = `shopify-override-rate-error-${index}`;

  const targetItems =
    scope === "variant"
      ? variants?.map((variant) => ({
          text: variant.title,
          description: variant.description,
          value: variant.id,
          disabled: variantOverrides.some(
            (item) =>
              sameOverrideTarget("variant", item.id, variant.id) &&
              !sameOverrideTarget("variant", item.id, override.id),
          ),
        })) ?? []
      : scope === "product"
        ? products?.map((product) => {
            const value = product.externalId || product.id;
            return {
              text: product.title,
              description: product.handle ? `/${product.handle}` : undefined,
              value,
              disabled: productOverrides.some(
                (item) =>
                  sameOverrideTarget("product", item.id, value) &&
                  !sameOverrideTarget("product", item.id, override.id),
              ),
            };
          }) ?? []
        : collections?.map((collection) => ({
            text: collection.title,
            description: collection.handle
              ? `/${collection.handle}`
              : undefined,
            value: collection.id,
            disabled: collectionOverrides.some(
              (item) =>
                sameOverrideTarget("collection", item.id, collection.id) &&
                !sameOverrideTarget("collection", item.id, override.id),
            ),
          })) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between py-2 pl-2">
        <div className="flex items-center gap-1.5 text-neutral-800">
          <ArrowTurnRight2 className="size-3 shrink-0" />
          <span className="text-sm font-medium">
            {index === 0 ? "Reward condition" : "Additional condition"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {count > 1 && (
            <div className="text-content-default flex h-5 items-center rounded-md bg-neutral-200 px-2 text-xs font-medium">
              #{index + 1}
            </div>
          )}
          {scope === "collection" && collectionOverrides.length > 1 && (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-6 w-fit px-1"
                icon={<ChevronUp className="size-4" />}
                aria-label={`Move ${override.title} collection condition up`}
                disabled={!canMoveUp}
                onClick={onMoveUp}
              />
              <Button
                type="button"
                variant="outline"
                className="h-6 w-fit px-1"
                icon={<ChevronDown className="size-4" />}
                aria-label={`Move ${override.title} collection condition down`}
                disabled={!canMoveDown}
                onClick={onMoveDown}
              />
            </>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-6 w-fit px-1"
            icon={<X className="size-4" />}
            aria-label={`Remove ${override.title} condition`}
            onClick={onRemove}
          />
        </div>
      </div>

      <div className="border-border-subtle rounded-lg border bg-white p-2.5">
        <div className="border-border-subtle rounded-md border bg-white">
          <div className="flex items-center gap-2.5 p-2.5">
            <RewardIconSquare icon={Shopify} />
            <span className="min-w-0 leading-relaxed">
              If{" "}
              <InlineBadgePopover
                text={getScopeLabel(scope)}
                buttonClassName="align-middle"
              >
                <OverrideScopePickerMenu
                  currentScope={scope}
                  override={override}
                  variants={variants}
                  products={products}
                  collections={collections}
                  variantOverrides={variantOverrides}
                  productOverrides={productOverrides}
                  collectionOverrides={collectionOverrides}
                  onConditionChange={onConditionChange}
                />
              </InlineBadgePopover>{" "}
              is{" "}
              <InlineBadgePopover
                text={override.title}
                buttonClassName="max-w-56 align-middle"
                contentClassName="block truncate"
              >
                <InlineBadgePopoverMenu
                  search
                  selectedValue={override.id}
                  items={targetItems}
                  onSelect={(value) => {
                    if (scope === "variant") {
                      const variant = variants?.find(
                        (item) => item.id === value,
                      );
                      if (variant) {
                        onConditionChange("variant", value, variant.title);
                      }
                    } else if (scope === "product") {
                      const product = products?.find(
                        (item) => (item.externalId || item.id) === value,
                      );
                      if (product) {
                        onConditionChange("product", value, product.title);
                      }
                    } else {
                      const collection = collections?.find(
                        (item) => item.id === value,
                      );
                      if (collection) {
                        onConditionChange(
                          "collection",
                          value,
                          collection.title,
                        );
                      }
                    }
                  }}
                />
              </InlineBadgePopover>
            </span>
          </div>
        </div>

        <RewardConnectorLine />

        <div className="border-border-subtle flex items-start gap-2.5 rounded-md border bg-white p-2.5">
          <RewardIconSquare icon={MoneyBills2} />
          <span className="min-w-0 leading-relaxed">
            Then pay{" "}
            <RateBadge
              value={override.returningRate}
              onChange={(value) => onRateChange("returningRate", value)}
              suffix={rateSuffix}
              label={`${override.title} commission rate`}
              errorId={errorId}
            />
            {segmentMode === "none" ? (
              <> per sale</>
            ) : segmentMode === "new_vs_returning" ? (
              <>
                {" "}
                for returning customers and{" "}
                <RateBadge
                  value={newCustomerRate}
                  onChange={(value) => onRateChange("newRate", value)}
                  suffix={rateSuffix}
                  label={`${override.title} new customer commission rate`}
                  errorId={errorId}
                />{" "}
                for new customers
              </>
            ) : (
              <>
                {" "}
                for customers outside {segmentName || "the segment"} and{" "}
                <RateBadge
                  value={segmentMemberRate}
                  onChange={(value) => onRateChange("segmentRate", value)}
                  suffix={rateSuffix}
                  label={`${override.title} Shopify segment commission rate`}
                  errorId={errorId}
                />{" "}
                for customers in {segmentName || "the segment"}
              </>
            )}
            .
          </span>
        </div>

        {hasInvalidRates && (
          <p
            id={errorId}
            aria-live="polite"
            className="ml-9 mt-2 text-xs text-red-600"
          >
            Enter a commission rate from 0 to 100.
          </p>
        )}
      </div>
    </div>
  );
}

function AddConditionPopover({
  variants,
  products,
  collections,
  variantOverrides,
  productOverrides,
  collectionOverrides,
  onAddVariant,
  onAddProduct,
  onAddCollection,
}: {
  variants?: ShopifyVariantItem[];
  products?: ShopifyProductItem[];
  collections?: ShopifyCollectionItem[];
  variantOverrides: ShopifyRewardVariantOverrideDraft[];
  productOverrides: ShopifyRewardProductOverrideDraft[];
  collectionOverrides: ShopifyRewardCollectionOverrideDraft[];
  onAddVariant: (variant: ShopifyVariantItem) => void;
  onAddProduct: (product: ShopifyProductItem) => void;
  onAddCollection: (collection: ShopifyCollectionItem) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [scope, setScope] = useState<AddConditionScope | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setScope(null);
      setSearch("");
    }
  }, [isOpen]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleVariants = variants?.filter((variant) =>
    `${variant.title} ${variant.description ?? ""}`
      .toLowerCase()
      .includes(normalizedSearch),
  );
  const visibleProducts = products?.filter((product) =>
    product.title.toLowerCase().includes(normalizedSearch),
  );
  const visibleCollections = collections?.filter((collection) =>
    collection.title.toLowerCase().includes(normalizedSearch),
  );

  return (
    <Popover
      openPopover={isOpen}
      setOpenPopover={setIsOpen}
      align="start"
      content={
        <div className="w-80 p-1">
          {scope === null ? (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setScope("variant")}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-neutral-100"
              >
                <Box className="mt-0.5 size-4 text-neutral-600" />
                <span>
                  <span className="block text-sm font-medium text-neutral-800">
                    Variant
                  </span>
                  <span className="block text-xs text-neutral-500">
                    Override commission for one product variant.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setScope("product")}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-neutral-100"
              >
                <Package className="mt-0.5 size-4 text-neutral-600" />
                <span>
                  <span className="block text-sm font-medium text-neutral-800">
                    Product
                  </span>
                  <span className="block text-xs text-neutral-500">
                    Override commission for one product.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setScope("collection")}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-neutral-100"
              >
                <Layers className="mt-0.5 size-4 text-neutral-600" />
                <span>
                  <span className="block text-sm font-medium text-neutral-800">
                    Collection
                  </span>
                  <span className="block text-xs text-neutral-500">
                    Override commission for one collection.
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 border-b border-neutral-200 px-1.5 pb-2">
                <button
                  type="button"
                  onClick={() => {
                    setScope(null);
                    setSearch("");
                  }}
                  aria-label="Choose another condition type"
                  className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <Search className="size-4 text-neutral-400" />
                <input
                  autoFocus
                  aria-label={`Search ${scope === "variant" ? "variants" : scope === "product" ? "products" : "collections"}`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={`Search ${scope === "variant" ? "variants" : scope === "product" ? "products" : "collections"}`}
                  className="outline-hidden min-w-0 flex-1 border-0 bg-transparent p-0 text-sm focus:ring-0"
                />
              </div>
              <div className="scrollbar-hide mt-1 max-h-64 overflow-y-auto">
                {scope === "variant" ? (
                  variants === undefined ? (
                    <p className="px-3 py-6 text-center text-xs text-neutral-500">
                      Loading variants…
                    </p>
                  ) : visibleVariants?.length ? (
                    visibleVariants.map((variant) => {
                      const isAdded = variantOverrides.some((override) =>
                        sameOverrideTarget("variant", override.id, variant.id),
                      );
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          disabled={isAdded}
                          onClick={() => {
                            onAddVariant(variant);
                            setIsOpen(false);
                          }}
                          className="flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-neutral-800">
                              {variant.title}
                            </span>
                            {variant.description && (
                              <span className="block truncate text-xs text-neutral-500">
                                {variant.description}
                              </span>
                            )}
                          </span>
                          {isAdded && (
                            <span className="shrink-0 text-xs text-neutral-500">
                              Added
                            </span>
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <p className="px-3 py-6 text-center text-xs text-neutral-500">
                      No variants found
                    </p>
                  )
                ) : scope === "product" ? (
                  products === undefined ? (
                    <p className="px-3 py-6 text-center text-xs text-neutral-500">
                      Loading products…
                    </p>
                  ) : visibleProducts?.length ? (
                    visibleProducts.map((product) => {
                      const id = product.externalId || product.id;
                      const isAdded = productOverrides.some((override) =>
                        sameOverrideTarget("product", override.id, id),
                      );
                      return (
                        <button
                          key={id}
                          type="button"
                          disabled={isAdded}
                          onClick={() => {
                            onAddProduct(product);
                            setIsOpen(false);
                          }}
                          className="flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-neutral-800">
                              {product.title}
                            </span>
                            {product.handle && (
                              <span className="block truncate text-xs text-neutral-500">
                                /{product.handle}
                              </span>
                            )}
                          </span>
                          {isAdded && (
                            <span className="shrink-0 text-xs text-neutral-500">
                              Added
                            </span>
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <p className="px-3 py-6 text-center text-xs text-neutral-500">
                      No products found
                    </p>
                  )
                ) : collections === undefined ? (
                  <p className="px-3 py-6 text-center text-xs text-neutral-500">
                    Loading collections…
                  </p>
                ) : visibleCollections?.length ? (
                  visibleCollections.map((collection) => {
                    const isAdded = collectionOverrides.some((override) =>
                      sameOverrideTarget(
                        "collection",
                        override.id,
                        collection.id,
                      ),
                    );
                    return (
                      <button
                        key={collection.id}
                        type="button"
                        disabled={isAdded}
                        onClick={() => {
                          onAddCollection(collection);
                          setIsOpen(false);
                        }}
                        className="flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-800">
                            {collection.title}
                          </span>
                          {collection.handle && (
                            <span className="block truncate text-xs text-neutral-500">
                              /{collection.handle}
                            </span>
                          )}
                        </span>
                        {isAdded && (
                          <span className="shrink-0 text-xs text-neutral-500">
                            Added
                          </span>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <p className="px-3 py-6 text-center text-xs text-neutral-500">
                    No collections found
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      }
    >
      <Button
        type="button"
        variant="secondary"
        className="h-8 rounded-lg"
        icon={<ArrowTurnRight2 className="size-4" />}
        text="Add condition"
        onClick={() => setIsOpen(true)}
      />
    </Popover>
  );
}

export function ShopifyEcommerceRewardSheet({
  isOpen,
  setIsOpen,
  reward,
}: ShopifyEcommerceRewardSheetProps) {
  const { id: workspaceId } = useWorkspace();
  const { group, mutateGroup } = useGroup();
  const { program, mutate: mutateProgram } = useProgram();
  const { queryParams } = useRouterStuff();

  const initialConfig = useMemo<ShopifyEcommerceRewardConfig>(() => {
    const parsedExisting = ShopifyEcommerceRewardConfigSchema.safeParse(
      reward?.config,
    );
    if (parsedExisting.success) {
      const existing = parsedExisting.data;
      return {
        type: "shopify_ecommerce",
        activation: existing.activation,
        customerSegmentMode: existing.customerSegmentMode ?? "new_vs_returning",
        baseRateType: existing.baseRateType ?? "percentage",
        baseReturningRate:
          existing.baseReturningRate ??
          (reward?.amountInPercentage ? Number(reward.amountInPercentage) : 10),
        baseNewRate: existing.baseNewRate ?? 20,
        shopifySegment: existing.shopifySegment ?? null,
        collectionOverrides: existing.collectionOverrides ?? [],
        productOverrides: existing.productOverrides ?? [],
        variantOverrides: existing.variantOverrides ?? [],
        subscriptionRules: existing.subscriptionRules,
      };
    }

    return {
      type: "shopify_ecommerce",
      activation: { published: true, startsAt: null, endsAt: null },
      customerSegmentMode: "new_vs_returning",
      baseRateType: "percentage",
      baseReturningRate: reward?.amountInPercentage
        ? Number(reward.amountInPercentage)
        : 10,
      baseNewRate: 20,
      shopifySegment: null,
      collectionOverrides: [],
      productOverrides: [],
      variantOverrides: [],
      subscriptionRules: {
        mode: "first_sale",
        recurringOrderCount: null,
      },
    };
  }, [reward]);

  const [lifecycleMode, setLifecycleMode] =
    useState<ShopifyRewardLifecycleMode>(() =>
      getShopifyRewardLifecycleMode(initialConfig.activation),
    );
  const [startsAt, setStartsAt] = useState(() =>
    toShopifyRewardDateTimeDraft(initialConfig.activation.startsAt),
  );
  const [endsAt, setEndsAt] = useState(() =>
    toShopifyRewardDateTimeDraft(initialConfig.activation.endsAt),
  );

  const [segmentMode, setSegmentMode] = useState<CustomerSegmentMode>(
    initialConfig.customerSegmentMode,
  );
  const [baseReturningRate, setBaseReturningRate] = useState(
    toShopifyRewardRateDraft(initialConfig.baseReturningRate),
  );
  const [baseRateType, setBaseRateType] = useState<RateType>(
    initialConfig.baseRateType,
  );
  const [baseNewRate, setBaseNewRate] = useState(
    toShopifyRewardRateDraft(initialConfig.baseNewRate),
  );
  const [shopifySegment, setShopifySegment] =
    useState<ShopifyRewardSegmentDraft | null>(
      initialConfig.shopifySegment
        ? {
            ...initialConfig.shopifySegment,
            rate: toShopifyRewardRateDraft(initialConfig.shopifySegment.rate),
          }
        : null,
    );
  const [collectionOverrides, setCollectionOverrides] = useState<
    ShopifyRewardCollectionOverrideDraft[]
  >(() =>
    initialConfig.collectionOverrides.map(toShopifyCollectionOverrideDraft),
  );
  const [productOverrides, setProductOverrides] = useState<
    ShopifyRewardProductOverrideDraft[]
  >(() => initialConfig.productOverrides.map(toShopifyProductOverrideDraft));
  const [variantOverrides, setVariantOverrides] = useState<
    ShopifyRewardVariantOverrideDraft[]
  >(() => initialConfig.variantOverrides.map(toShopifyVariantOverrideDraft));
  const [subscriptionMode, setSubscriptionMode] =
    useState<ShopifySubscriptionCommissionMode>(
      initialConfig.subscriptionRules.mode,
    );
  const [recurringOrderCount, setRecurringOrderCount] = useState(
    String(initialConfig.subscriptionRules.recurringOrderCount ?? 1),
  );

  useEffect(() => {
    if (!isOpen) return;

    setLifecycleMode(getShopifyRewardLifecycleMode(initialConfig.activation));
    setStartsAt(
      toShopifyRewardDateTimeDraft(initialConfig.activation.startsAt),
    );
    setEndsAt(toShopifyRewardDateTimeDraft(initialConfig.activation.endsAt));
    setSegmentMode(initialConfig.customerSegmentMode);
    setBaseRateType(initialConfig.baseRateType);
    setBaseReturningRate(
      toShopifyRewardRateDraft(initialConfig.baseReturningRate),
    );
    setBaseNewRate(toShopifyRewardRateDraft(initialConfig.baseNewRate));
    setShopifySegment(
      initialConfig.shopifySegment
        ? {
            ...initialConfig.shopifySegment,
            rate: toShopifyRewardRateDraft(initialConfig.shopifySegment.rate),
          }
        : null,
    );
    setCollectionOverrides(
      initialConfig.collectionOverrides.map(toShopifyCollectionOverrideDraft),
    );
    setProductOverrides(
      initialConfig.productOverrides.map(toShopifyProductOverrideDraft),
    );
    setVariantOverrides(
      initialConfig.variantOverrides.map(toShopifyVariantOverrideDraft),
    );
    setSubscriptionMode(initialConfig.subscriptionRules.mode);
    setRecurringOrderCount(
      String(initialConfig.subscriptionRules.recurringOrderCount ?? 1),
    );
  }, [isOpen, initialConfig]);

  const { data: collections } = useSWR<ShopifyCollectionItem[]>(
    isOpen && workspaceId
      ? `/api/weletic/collections?workspaceId=${workspaceId}`
      : null,
    fetcher,
  );

  const { data: products } = useSWR<ShopifyProductItem[]>(
    isOpen && workspaceId
      ? `/api/weletic/products?workspaceId=${workspaceId}`
      : null,
    fetcher,
  );
  const variants = useMemo(() => flattenShopifyVariants(products), [products]);

  const { data: segments } = useSWR<ShopifySegmentItem[]>(
    isOpen && workspaceId && segmentMode === "shopify_segment"
      ? `/api/weletic/segments?workspaceId=${workspaceId}`
      : null,
    fetcher,
  );

  const { executeAsync: saveReward, isPending: isSaving } = useAction(
    upsertShopifyEcommerceRewardAction,
    {
      onSuccess: async () => {
        toast.success(
          reward ? "Shopify reward updated!" : "Shopify reward created!",
        );
        queryParams({ del: "rewardId" });
        setIsOpen(false);
        await Promise.all([
          mutateProgram(),
          mutateGroup(),
          mutateRewardConfiguration({
            programId: program?.id,
            groupIdentifiers: [group?.id, group?.slug],
          }),
        ]);
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "Failed to save Shopify reward");
      },
    },
  );

  const { executeAsync: deleteReward, isPending: isDeleting } = useAction(
    deleteRewardAction,
    {
      onSuccess: async () => {
        toast.success("Shopify reward removed!");
        queryParams({ del: "rewardId" });
        setIsOpen(false);
        await Promise.all([
          mutateProgram(),
          mutateGroup(),
          mutateRewardConfiguration({
            programId: program?.id,
            groupIdentifiers: [group?.id, group?.slug],
          }),
        ]);
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "Failed to remove reward");
      },
    },
  );

  const formDraft: ShopifyEcommerceRewardDraft = {
    lifecycleMode,
    startsAt,
    endsAt,
    customerSegmentMode: segmentMode,
    baseRateType,
    baseReturningRate,
    baseNewRate,
    shopifySegment,
    collectionOverrides,
    productOverrides,
    variantOverrides,
    subscriptionMode,
    recurringOrderCount,
  };
  const {
    lifecycleValid,
    baseRatesValid,
    segmentValid,
    subscriptionValid,
    valid: canSave,
  } = validateShopifyEcommerceRewardDraft(formDraft);
  const previewConfig = serializeShopifyEcommerceRewardDraft({
    draft: formDraft,
    fallbackConfig: initialConfig,
  });

  const rateSuffix =
    baseRateType === "percentage"
      ? "%"
      : (program?.accountingCurrency ?? "USD").toUpperCase();

  const handleSave = async () => {
    if (!workspaceId || !group) return;
    if (!canSave) {
      toast.error("Fix the highlighted reward fields before saving.");
      return;
    }

    const configPayload = serializeShopifyEcommerceRewardDraft({
      draft: formDraft,
      fallbackConfig: initialConfig,
    });
    if (!configPayload) {
      toast.error("Fix the highlighted reward fields before saving.");
      return;
    }

    await saveReward({
      workspaceId,
      groupId: group.id,
      rewardId: reward?.id,
      config: configPayload,
    });
  };

  const handleDelete = async () => {
    if (!workspaceId || !reward) return;
    if (
      confirm("Are you sure you want to remove the Shopify eCommerce reward?")
    ) {
      await deleteReward({
        workspaceId,
        rewardId: reward.id,
      });
    }
  };

  const updateProductOverrideRate = (
    index: number,
    field: OverrideRateField,
    value: string,
  ) => {
    setProductOverrides((current) =>
      current.map((override, currentIndex) =>
        currentIndex === index ? { ...override, [field]: value } : override,
      ),
    );
  };

  const updateVariantOverrideRate = (
    index: number,
    field: OverrideRateField,
    value: string,
  ) => {
    setVariantOverrides((current) =>
      current.map((override, currentIndex) =>
        currentIndex === index ? { ...override, [field]: value } : override,
      ),
    );
  };

  const updateCollectionOverrideRate = (
    index: number,
    field: OverrideRateField,
    value: string,
  ) => {
    setCollectionOverrides((current) =>
      current.map((override, currentIndex) =>
        currentIndex === index ? { ...override, [field]: value } : override,
      ),
    );
  };

  const moveCollectionOverride = (fromIndex: number, toIndex: number) => {
    setCollectionOverrides((current) => {
      if (toIndex < 0 || toIndex >= current.length) return current;
      const reordered = [...current];
      [reordered[fromIndex], reordered[toIndex]] = [
        reordered[toIndex],
        reordered[fromIndex],
      ];
      return reordered;
    });
  };

  const removeOverride = (scope: AddConditionScope, index: number) => {
    if (scope === "variant") {
      setVariantOverrides((current) =>
        current.filter((_, currentIndex) => currentIndex !== index),
      );
    } else if (scope === "product") {
      setProductOverrides((current) =>
        current.filter((_, currentIndex) => currentIndex !== index),
      );
    } else {
      setCollectionOverrides((current) =>
        current.filter((_, currentIndex) => currentIndex !== index),
      );
    }
  };

  const retargetOverride = ({
    currentScope,
    scopedIndex,
    override,
    nextScope,
    id,
    title,
  }: {
    currentScope: AddConditionScope;
    scopedIndex: number;
    override: ShopifyRewardOverrideDraft;
    nextScope: AddConditionScope;
    id: string;
    title: string;
  }) => {
    if (currentScope !== nextScope) {
      removeOverride(currentScope, scopedIndex);
    }

    if (nextScope === "variant") {
      const nextOverride = retargetShopifyRewardOverrideDraft({
        override,
        scope: "variant",
        target: { id, title },
      });
      setVariantOverrides((current) =>
        currentScope === "variant"
          ? current.map((item, index) =>
              index === scopedIndex ? nextOverride : item,
            )
          : [...current, nextOverride],
      );
    } else if (nextScope === "product") {
      const nextOverride = retargetShopifyRewardOverrideDraft({
        override,
        scope: "product",
        target: { id, title },
      });
      setProductOverrides((current) =>
        currentScope === "product"
          ? current.map((item, index) =>
              index === scopedIndex ? nextOverride : item,
            )
          : [...current, nextOverride],
      );
    } else {
      const nextOverride = retargetShopifyRewardOverrideDraft({
        override,
        scope: "collection",
        target: { id, title },
      });
      setCollectionOverrides((current) =>
        currentScope === "collection"
          ? current.map((item, index) =>
              index === scopedIndex ? nextOverride : item,
            )
          : [...current, nextOverride],
      );
    }
  };

  const conditionEntries = [
    ...variantOverrides.map((override, scopedIndex) => ({
      scope: "variant" as const,
      scopedIndex,
      override,
    })),
    ...productOverrides.map((override, scopedIndex) => ({
      scope: "product" as const,
      scopedIndex,
      override,
    })),
    ...collectionOverrides.map((override, scopedIndex) => ({
      scope: "collection" as const,
      scopedIndex,
      override,
    })),
  ];
  const conditionCount = conditionEntries.length;

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) queryParams({ del: "rewardId" });
        setIsOpen(open);
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-neutral-200 px-6 py-4">
          <Sheet.Title className="text-lg font-semibold">
            {reward ? "Edit" : "Create"} Shopify eCommerce reward
          </Sheet.Title>
          <Sheet.Description className="sr-only">
            Configure Shopify commission rates, scoped overrides, and
            subscription-order eligibility.
          </Sheet.Description>
          <Button
            type="button"
            variant="outline"
            icon={<X className="size-5" />}
            className="h-auto w-fit p-1"
            aria-label="Close Shopify reward editor"
            onClick={() => setIsOpen(false)}
          />
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <RewardSheetCard
            title={
              <div className="w-full">
                <div className="flex min-w-0 items-start gap-2.5">
                  <RewardIconSquare icon={Shopify} />
                  <span className="min-w-0 leading-relaxed">
                    Pay a{" "}
                    <InlineBadgePopover
                      text={
                        baseRateType === "percentage" ? "Percentage" : "Flat"
                      }
                    >
                      <InlineBadgePopoverMenu
                        selectedValue={baseRateType}
                        onSelect={(value) => setBaseRateType(value as RateType)}
                        items={[
                          { text: "Percentage", value: "percentage" },
                          { text: "Flat", value: "flat" },
                        ]}
                      />
                    </InlineBadgePopover>{" "}
                    commission on all products with{" "}
                    <InlineBadgePopover
                      text={
                        SHOPIFY_CUSTOMER_SEGMENT_MODES.find(
                          ({ value }) => value === segmentMode,
                        )?.label
                      }
                      buttonClassName="align-middle"
                    >
                      <InlineBadgePopoverMenu
                        selectedValue={segmentMode}
                        onSelect={(value) =>
                          setSegmentMode(value as CustomerSegmentMode)
                        }
                        items={SHOPIFY_CUSTOMER_SEGMENT_MODES.map((mode) => ({
                          text: mode.label,
                          description: mode.description,
                          value: mode.value,
                        }))}
                      />
                    </InlineBadgePopover>
                    :{" "}
                    {segmentMode === "none" ? (
                      <>
                        <RateBadge
                          value={baseReturningRate}
                          onChange={setBaseReturningRate}
                          suffix={rateSuffix}
                          label="Commission rate for all customers"
                          errorId="shopify-base-rate-error"
                        />{" "}
                        per sale
                      </>
                    ) : segmentMode === "new_vs_returning" ? (
                      <>
                        <RateBadge
                          value={baseReturningRate}
                          onChange={setBaseReturningRate}
                          suffix={rateSuffix}
                          label="Returning customer commission rate"
                          errorId="shopify-base-rate-error"
                        />{" "}
                        for returning customers and{" "}
                        <RateBadge
                          value={baseNewRate}
                          onChange={setBaseNewRate}
                          suffix={rateSuffix}
                          label="New customer commission rate"
                          errorId="shopify-base-rate-error"
                        />{" "}
                        for new customers
                      </>
                    ) : (
                      <>
                        <RateBadge
                          value={baseReturningRate}
                          onChange={setBaseReturningRate}
                          suffix={rateSuffix}
                          label="Commission rate for customers outside the Shopify segment"
                          errorId="shopify-base-rate-error"
                        />{" "}
                        for customers outside{" "}
                        <InlineBadgePopover
                          text={
                            shopifySegment?.name ?? "Select Shopify segment"
                          }
                          invalid={!shopifySegment}
                        >
                          <InlineBadgePopoverMenu
                            search
                            selectedValue={shopifySegment?.id}
                            onSelect={(value) => {
                              const segment = segments?.find(
                                (item) => item.id === value,
                              );
                              setShopifySegment(
                                segment
                                  ? {
                                      id: segment.id,
                                      name: segment.name,
                                      rate: shopifySegment?.rate ?? baseNewRate,
                                    }
                                  : null,
                              );
                            }}
                            items={
                              segments?.map((segment) => ({
                                text: segment.name,
                                value: segment.id,
                              })) ?? []
                            }
                          />
                        </InlineBadgePopover>{" "}
                        and{" "}
                        <RateBadge
                          value={shopifySegment?.rate ?? ""}
                          onChange={(value) =>
                            setShopifySegment((current) =>
                              current ? { ...current, rate: value } : current,
                            )
                          }
                          suffix={rateSuffix}
                          label="Shopify segment member commission rate"
                          errorId="shopify-base-rate-error"
                        />{" "}
                        for customers in that segment
                      </>
                    )}
                    .
                  </span>
                </div>
                {(!baseRatesValid || !segmentValid) && (
                  <p
                    id="shopify-base-rate-error"
                    aria-live="polite"
                    className="ml-9 mt-2 text-xs text-red-600"
                  >
                    {!segmentValid
                      ? "Select a Shopify customer segment before saving."
                      : "Enter a commission rate from 0 to 100."}
                  </p>
                )}
              </div>
            }
            content={
              <div>
                {conditionEntries.map(
                  ({ scope, scopedIndex, override }, index) => (
                    <OverrideConditionBlock
                      key={`${scope}-${override.id}`}
                      index={index}
                      count={conditionCount}
                      scope={scope}
                      override={override}
                      variants={variants}
                      products={products}
                      collections={collections}
                      variantOverrides={variantOverrides}
                      productOverrides={productOverrides}
                      collectionOverrides={collectionOverrides}
                      segmentMode={segmentMode}
                      segmentName={shopifySegment?.name}
                      baseNewRate={baseNewRate}
                      segmentRate={shopifySegment?.rate}
                      rateSuffix={rateSuffix}
                      onConditionChange={(nextScope, id, title) =>
                        retargetOverride({
                          currentScope: scope,
                          scopedIndex,
                          override,
                          nextScope,
                          id,
                          title,
                        })
                      }
                      onRateChange={(field, value) => {
                        if (scope === "variant") {
                          updateVariantOverrideRate(scopedIndex, field, value);
                        } else if (scope === "product") {
                          updateProductOverrideRate(scopedIndex, field, value);
                        } else {
                          updateCollectionOverrideRate(
                            scopedIndex,
                            field,
                            value,
                          );
                        }
                      }}
                      canMoveUp={scope === "collection" && scopedIndex > 0}
                      canMoveDown={
                        scope === "collection" &&
                        scopedIndex < collectionOverrides.length - 1
                      }
                      onMoveUp={
                        scope === "collection"
                          ? () =>
                              moveCollectionOverride(
                                scopedIndex,
                                scopedIndex - 1,
                              )
                          : undefined
                      }
                      onMoveDown={
                        scope === "collection"
                          ? () =>
                              moveCollectionOverride(
                                scopedIndex,
                                scopedIndex + 1,
                              )
                          : undefined
                      }
                      onRemove={() => removeOverride(scope, scopedIndex)}
                    />
                  ),
                )}

                {!!conditionCount && <RewardConnectorLine className="h-3" />}

                <div className="flex items-center justify-between gap-3">
                  <AddConditionPopover
                    variants={variants}
                    products={products}
                    collections={collections}
                    variantOverrides={variantOverrides}
                    productOverrides={productOverrides}
                    collectionOverrides={collectionOverrides}
                    onAddVariant={(variant) =>
                      setVariantOverrides((current) => [
                        ...current,
                        {
                          id: variant.id,
                          title: variant.title,
                          returningRate: baseReturningRate,
                          newRate: baseNewRate,
                          segmentRate: shopifySegment?.rate ?? baseNewRate,
                        },
                      ])
                    }
                    onAddProduct={(product) =>
                      setProductOverrides((current) => [
                        ...current,
                        {
                          id: product.externalId || product.id,
                          title: product.title,
                          image: null,
                          returningRate: baseReturningRate,
                          newRate: baseNewRate,
                          segmentRate: shopifySegment?.rate ?? baseNewRate,
                        },
                      ])
                    }
                    onAddCollection={(collection) =>
                      setCollectionOverrides((current) => [
                        ...current,
                        {
                          id: collection.id,
                          title: collection.title,
                          returningRate: baseReturningRate,
                          newRate: baseNewRate,
                          segmentRate: shopifySegment?.rate ?? baseNewRate,
                        },
                      ])
                    }
                  />

                  <HelpPopover
                    label="How priority works"
                    accessibleLabel="How Shopify reward priority works"
                    content="Variant conditions override product conditions, which override collection conditions and then the all-products rate. If several collections match, the first listed collection wins."
                  />
                </div>
              </div>
            }
          />

          <RewardSheetCard
            className="shrink-0"
            title={
              <div className="w-full" data-testid="shopify-reward-lifecycle">
                <div className="flex min-w-0 items-start gap-2.5">
                  <RewardIconSquare icon={CalendarClock} />
                  <span className="min-w-0 leading-relaxed">
                    This reward is{" "}
                    <InlineBadgePopover
                      text={
                        SHOPIFY_REWARD_LIFECYCLE_MODES.find(
                          ({ value }) => value === lifecycleMode,
                        )?.label
                      }
                    >
                      <InlineBadgePopoverMenu
                        selectedValue={lifecycleMode}
                        onSelect={(value) =>
                          setLifecycleMode(value as ShopifyRewardLifecycleMode)
                        }
                        items={SHOPIFY_REWARD_LIFECYCLE_MODES.map((mode) => ({
                          text: mode.label,
                          description: mode.description,
                          value: mode.value,
                        }))}
                      />
                    </InlineBadgePopover>
                    .
                  </span>
                </div>

                {!lifecycleValid && (
                  <p
                    id="shopify-lifecycle-error"
                    aria-live="polite"
                    className="ml-9 mt-2 text-xs text-red-600"
                  >
                    {!startsAt
                      ? "Choose when the reward should start."
                      : "Choose an end date after the start date, or leave it blank."}
                  </p>
                )}
              </div>
            }
            content={
              lifecycleMode === "scheduled" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-neutral-700">
                    Starts
                    <input
                      type="datetime-local"
                      value={startsAt}
                      aria-invalid={!lifecycleValid || undefined}
                      aria-describedby={
                        !lifecycleValid ? "shopify-lifecycle-error" : undefined
                      }
                      onChange={(event) => setStartsAt(event.target.value)}
                      className="h-9 min-w-0 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-normal text-neutral-900 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-neutral-700">
                    Ends (optional)
                    <input
                      type="datetime-local"
                      value={endsAt}
                      aria-invalid={!lifecycleValid || undefined}
                      aria-describedby={
                        !lifecycleValid ? "shopify-lifecycle-error" : undefined
                      }
                      onChange={(event) => setEndsAt(event.target.value)}
                      className="h-9 min-w-0 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-normal text-neutral-900 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
                    />
                  </label>
                  <p className="text-xs font-normal text-neutral-500 sm:col-span-2">
                    Times use your local time zone. Order eligibility is checked
                    against the time the Shopify order occurred.
                  </p>
                </div>
              ) : undefined
            }
          />

          <RewardSheetCard
            title={
              <div className="w-full">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <RewardIconSquare icon={RefreshCw} />
                    <span className="min-w-0 leading-relaxed">
                      For subscription products, pay commission on{" "}
                      <InlineBadgePopover
                        text={getSubscriptionDisplayText(subscriptionMode)}
                      >
                        <InlineBadgePopoverMenu
                          selectedValue={subscriptionMode}
                          onSelect={(value) =>
                            setSubscriptionMode(
                              value as ShopifySubscriptionCommissionMode,
                            )
                          }
                          items={SHOPIFY_SUBSCRIPTION_COMMISSION_MODES.map(
                            (mode) => ({
                              text: mode.label,
                              description: mode.description,
                              value: mode.value,
                            }),
                          )}
                        />
                      </InlineBadgePopover>
                      {subscriptionMode === "limited_recurring_orders" && (
                        <>
                          :{" "}
                          <RecurringOrderCountBadge
                            value={recurringOrderCount}
                            onChange={setRecurringOrderCount}
                            errorId="shopify-subscription-count-error"
                          />
                        </>
                      )}
                      .
                    </span>
                  </div>
                  <HelpPopover
                    accessibleLabel="How subscription orders are counted"
                    content="A subscription series is identified per customer, selling plan, and variant. Limited mode pays the first sale plus the configured number of renewals."
                  />
                </div>
                {!subscriptionValid && (
                  <p
                    id="shopify-subscription-count-error"
                    aria-live="polite"
                    className="ml-9 mt-2 text-xs text-red-600"
                  >
                    Enter at least one recurring order.
                  </p>
                )}
              </div>
            }
          />

          <ShopifyRewardTester
            config={previewConfig}
            products={products}
            accountingCurrency={program?.accountingCurrency ?? "USD"}
          />
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-neutral-200 bg-white px-6 py-4">
          <div>
            {reward && (
              <Button
                type="button"
                variant="outline"
                text="Remove reward"
                onClick={handleDelete}
                loading={isDeleting}
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              text="Cancel"
              onClick={() => setIsOpen(false)}
            />
            <Button
              type="button"
              variant="primary"
              data-testid="save-shopify-reward"
              text={reward ? "Save changes" : "Create reward"}
              onClick={handleSave}
              loading={isSaving}
              disabled={!canSave}
            />
          </div>
        </div>
      </div>
    </Sheet>
  );
}
