"use client";

import { createDiscountAction } from "@/lib/actions/partners/create-discount";
import { deleteDiscountAction } from "@/lib/actions/partners/delete-discount";
import { updateDiscountAction } from "@/lib/actions/partners/update-discount";
import { constructDiscountAmount } from "@/lib/api/sales/construct-discount-amount";
import { handleMoneyInputChange, handleMoneyKeyDown } from "@/lib/form-utils";
import { mutatePrefix } from "@/lib/swr/mutate";
import useGroup from "@/lib/swr/use-group";
import useProgram from "@/lib/swr/use-program";
import useWorkspace from "@/lib/swr/use-workspace";
import { DiscountProps } from "@/lib/types";
import {
  createDiscountSchema,
  ShopifyDiscountType,
} from "@/lib/zod/schemas/discount";
import { RECURRING_MAX_DURATIONS } from "@/lib/zod/schemas/misc";
import { Shopify } from "@/ui/guides/icons/shopify";
import { DurationPopoverContent } from "@/ui/shared/duration-popover-content";
import { X } from "@/ui/shared/icons";
import {
  InlineBadgePopover,
  InlineBadgePopoverMenu,
} from "@/ui/shared/inline-badge-popover";
import { UpgradeRequiredToast } from "@/ui/shared/upgrade-required-toast";
import {
  Button,
  CircleInfo,
  Combobox,
  ComboboxOption,
  InfoTooltip,
  Sheet,
  Switch,
  Tooltip,
  useRouterStuff,
} from "@dub/ui";
import { ArrowUpRight, CircleCheck, StripeIcon, Tag } from "@dub/ui/icons";
import { capitalize, cn, fetcher, pluralize } from "@dub/utils";
import { DiscountProvider } from "@prisma/client";
import { useAction } from "next-safe-action/hooks";
import {
  ChangeEvent,
  Dispatch,
  PropsWithChildren,
  ReactNode,
  SetStateAction,
  useRef,
  useState,
} from "react";
import { FormProvider, useForm, useFormContext } from "react-hook-form";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";
import * as z from "zod/v4";
import { ERROR_MAP } from "../constants";
import { RewardDiscountPartnersCard } from "../groups/reward-discount-partners-card";
import {
  getShopifyCustomerDiscountSummary,
  getShopifyDiscountConfig,
} from "./shopify-discount-summary";

interface DiscountSheetProps {
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  discount?: DiscountProps;
  defaultDiscountValues?: DiscountProps;
}

type FormData = z.infer<typeof createDiscountSchema>;

export const useAddEditDiscountForm = () => useFormContext<FormData>();

const COUPON_CREATION_OPTIONS = [
  {
    label: "New Stripe coupon",
    description: "Create a new coupon",
    useExisting: false,
  },
  {
    label: "Use Stripe coupon ID",
    description: "Use an existing coupon",
    useExisting: true,
  },
] as const;

const SHOPIFY_CREATION_OPTIONS = [
  {
    label: "New Shopify discount",
    description: "Create and auto-provision a new discount rule",
    useExisting: false,
  },
  {
    label: "Use existing Shopify discount",
    description: "Link to an existing discount code or ID from Shopify Admin",
    useExisting: true,
  },
] as const;

const SHOPIFY_DISCOUNT_TYPE_OPTIONS = [
  {
    type: "amount_off_order" as const,
    title: "Amount off order",
    description: "Discount the entire order by a percentage or fixed amount",
  },
  {
    type: "amount_off_products" as const,
    title: "Amount off products",
    description: "Discount specific products or collections in the order",
  },
  {
    type: "bxgy" as const,
    title: "Buy X Get Y (BXGY)",
    description:
      "Reward customers with discounted or free items when buying qualifying items",
  },
  {
    type: "free_shipping" as const,
    title: "Free shipping",
    description:
      "Offer free shipping with optional minimum spend or shipping price cap",
  },
] as const;

const DEFAULT_MAX_DURATION = 6;

interface CatalogProduct {
  id: string;
  externalId?: string;
  title: string;
  handle: string;
  variants?: Array<{
    id: string;
    externalId?: string;
    title: string;
    sku: string | null;
  }>;
}

interface CatalogCollection {
  id: string;
  title: string;
  handle: string;
  productsCount?: number;
}

function ProductSelector({
  productIds,
  onChange,
  disabled,
}: {
  productIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { id: workspaceId } = useWorkspace();
  const { data: products } = useSWR<CatalogProduct[]>(
    workspaceId ? `/api/weletic/products?workspaceId=${workspaceId}` : null,
    fetcher,
  );
  const [isOpen, setIsOpen] = useState(false);

  const productOptions: ComboboxOption[] = (products || []).map((p) => ({
    value: p.externalId || p.id,
    label: p.title,
    meta: { handle: p.handle, id: p.id, externalId: p.externalId },
  }));

  const toggleProduct = (id: string) => {
    if (productIds.includes(id)) {
      onChange(productIds.filter((item) => item !== id));
    } else {
      onChange([...productIds, id]);
    }
  };

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-neutral-700">
        Target Products ({productIds.length} selected)
      </label>
      {!disabled && (
        <Combobox
          selected={null}
          setSelected={(option: ComboboxOption) => {
            if (option?.value) {
              toggleProduct(option.value);
            }
          }}
          options={productOptions}
          caret={true}
          placeholder="Search and select products..."
          searchPlaceholder="Search products by title..."
          optionDescription={(opt) =>
            opt.meta?.handle ? `/${opt.meta.handle}` : undefined
          }
          buttonProps={{
            className: "w-full h-9 justify-start px-3 text-sm",
          }}
          open={isOpen}
          onOpenChange={setIsOpen}
        />
      )}
      {productIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {productIds.map((id) => {
            const product = products?.find(
              (p) => p.id === id || p.externalId === id,
            );
            const label = product?.title || id;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md bg-neutral-200/70 px-2 py-1 text-xs text-neutral-800"
              >
                {label}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => toggleProduct(id)}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CollectionSelector({
  collectionIds,
  onChange,
  disabled,
}: {
  collectionIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { id: workspaceId } = useWorkspace();
  const { data: collections } = useSWR<CatalogCollection[]>(
    workspaceId ? `/api/weletic/collections?workspaceId=${workspaceId}` : null,
    fetcher,
  );
  const [isOpen, setIsOpen] = useState(false);

  const collectionOptions: ComboboxOption[] = (collections || []).map((c) => ({
    value: c.id,
    label: c.title,
    meta: { handle: c.handle, productsCount: c.productsCount },
  }));

  const toggleCollection = (id: string) => {
    if (collectionIds.includes(id)) {
      onChange(collectionIds.filter((item) => item !== id));
    } else {
      onChange([...collectionIds, id]);
    }
  };

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-neutral-700">
        Target Collections ({collectionIds.length} selected)
      </label>
      {!disabled && (
        <Combobox
          selected={null}
          setSelected={(option: ComboboxOption) => {
            if (option?.value) {
              toggleCollection(option.value);
            }
          }}
          options={collectionOptions}
          caret={true}
          placeholder="Search and select collections..."
          searchPlaceholder="Search collections by title..."
          optionDescription={(opt) =>
            opt.meta?.handle ? `/${opt.meta.handle}` : undefined
          }
          buttonProps={{
            className: "w-full h-9 justify-start px-3 text-sm",
          }}
          open={isOpen}
          onOpenChange={setIsOpen}
        />
      )}
      {collectionIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {collectionIds.map((id) => {
            const col = collections?.find((c) => c.id === id);
            const label = col?.title || id;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md bg-neutral-200/70 px-2 py-1 text-xs text-neutral-800"
              >
                {label}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => toggleCollection(id)}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DiscountSheetContent({
  setIsOpen,
  discount,
  defaultDiscountValues,
}: DiscountSheetProps) {
  const formRef = useRef<HTMLFormElement>(null);

  const { group, mutateGroup } = useGroup();
  const { mutate: mutateProgram } = useProgram();
  const { id: workspaceId, defaultProgramId, shopifyStoreId } = useWorkspace();

  const isEdit = Boolean(discount?.id);

  const discountProvider =
    discount?.provider ??
    defaultDiscountValues?.provider ??
    (shopifyStoreId ? DiscountProvider.shopify : DiscountProvider.stripe);

  const [useExistingCoupon, setUseExistingCoupon] = useState(
    discountProvider === DiscountProvider.shopify
      ? true
      : Boolean(discount?.couponId || defaultDiscountValues?.couponId),
  );

  const [useStripeTestCouponId, setUseStripeTestCouponId] = useState(
    Boolean(discount?.couponTestId ?? defaultDiscountValues?.couponTestId),
  );

  const [isChangingShopifyCampaign, setIsChangingShopifyCampaign] =
    useState(false);

  const initialShopifyConfig = getShopifyDiscountConfig({
    config: discount?.shopifyConfig,
    description: discount?.description,
  });
  const initialShopifyType: ShopifyDiscountType = initialShopifyConfig.type;
  const initialProductIds = initialShopifyConfig.productIds;
  const initialCollectionIds = initialShopifyConfig.collectionIds;
  const initialBxgy = {
    buyQuantity: 1,
    getQuantity: 1,
    discountType: "percentage" as const,
    discountValue: 100,
    ...initialShopifyConfig.bxgy,
  };
  const initialFreeShipping = {
    minimumSubtotal: initialShopifyConfig.freeShipping?.minimumSubtotal
      ? initialShopifyConfig.freeShipping.minimumSubtotal / 100
      : undefined,
    maximumShippingPrice: initialShopifyConfig.freeShipping
      ?.maximumShippingPrice
      ? initialShopifyConfig.freeShipping.maximumShippingPrice / 100
      : undefined,
  };

  const defaultValuesSource = discount ||
    defaultDiscountValues || {
      amount: 10,
      type: "percentage",
      maxDuration: DEFAULT_MAX_DURATION,
      couponId: "",
      couponTestId: "",
      autoProvisionEnabledAt: null,
    }; // default is 10% for 6 months

  const form = useForm<FormData>({
    defaultValues: {
      amount:
        defaultValuesSource.type === "flat"
          ? defaultValuesSource.amount / 100
          : defaultValuesSource.amount,
      type: defaultValuesSource.type,
      maxDuration:
        defaultValuesSource.maxDuration === null
          ? Infinity
          : defaultValuesSource.maxDuration,
      couponId: defaultValuesSource.couponId || "",
      couponTestId: defaultValuesSource.couponTestId,
      autoProvision: Boolean(defaultValuesSource.autoProvisionEnabledAt),
      provider: discountProvider,
      shopifyDiscountType: initialShopifyType,
      productIds: initialProductIds,
      collectionIds: initialCollectionIds,
      bxgy: initialBxgy,
      freeShipping: initialFreeShipping,
    },
  });

  const {
    formState: { isDirty },
    handleSubmit,
    register,
    resetField,
    setValue,
    watch,
  } = form;
  const [
    type,
    amount,
    maxDuration,
    autoProvision,
    provider,
    shopifyDiscountType,
    productIds = [],
    collectionIds = [],
    bxgy,
    freeShipping,
  ] = watch([
    "type",
    "amount",
    "maxDuration",
    "autoProvision",
    "provider",
    "shopifyDiscountType",
    "productIds",
    "collectionIds",
    "bxgy",
    "freeShipping",
  ]);

  const effectiveProvider = isEdit ? discountProvider : provider;
  const providerName =
    effectiveProvider === DiscountProvider.shopify ? "Shopify" : "Stripe";
  const effectiveShopifyType = shopifyDiscountType || initialShopifyType;

  const showStripeCouponFields =
    effectiveProvider === DiscountProvider.stripe &&
    !isEdit &&
    useExistingCoupon;

  const showShopifyCouponFields =
    effectiveProvider === DiscountProvider.shopify &&
    (!isEdit || isChangingShopifyCampaign);

  const isUsingExistingCoupon =
    effectiveProvider === DiscountProvider.shopify ||
    (effectiveProvider === DiscountProvider.stripe &&
      (isEdit ? Boolean(discount?.couponId) : useExistingCoupon));

  const editedCouponId = watch("couponId") || "";
  const linkedCouponId = isEdit ? discount?.couponId || "" : editedCouponId;
  const storeHandle = shopifyStoreId
    ? shopifyStoreId.replace(".myshopify.com", "")
    : null;

  const cleanNodeId = linkedCouponId.replace(
    /^gid:\/\/shopify\/DiscountCodeNode\//,
    "",
  );
  const isNumericNodeId = /^\d+$/.test(cleanNodeId);
  const shopifyAdminDiscountUrl =
    storeHandle && linkedCouponId
      ? isNumericNodeId
        ? `https://admin.shopify.com/store/${storeHandle}/discounts/${cleanNodeId}/codes`
        : `https://admin.shopify.com/store/${storeHandle}/discounts?query=${encodeURIComponent(linkedCouponId)}`
      : null;

  const shopifyCustomerDiscountSummary =
    discount && effectiveProvider === DiscountProvider.shopify
      ? getShopifyCustomerDiscountSummary({
          amount: discount.amount,
          type: discount.type,
          maxDuration: discount.maxDuration,
          config: initialShopifyConfig,
        })
      : null;

  const customerDiscountBenefit =
    shopifyCustomerDiscountSummary?.benefit ??
    (discount
      ? `Customers get ${constructDiscountAmount(discount)} off ${
          discount.maxDuration === null
            ? "for their lifetime"
            : discount.maxDuration === 0
              ? "on their first purchase"
              : `for ${discount.maxDuration} ${pluralize("month", discount.maxDuration)}`
        }.`
      : null);
  const customerDiscountScope =
    shopifyCustomerDiscountSummary?.scope ??
    "Applies according to the linked Stripe coupon.";

  const { executeAsync: createDiscount, isPending: isCreating } = useAction(
    createDiscountAction,
    {
      onSuccess: async () => {
        setIsOpen(false);
        toast.success("Discount created!");
        await mutateProgram();
        await mutateGroup();
        await mutatePrefix([
          "/api/groups",
          "/api/programs",
          "/api/partners",
          "/api/discount-codes",
        ]);
      },
      onError({ error }) {
        if (error.serverError) {
          const code = Object.keys(ERROR_MAP).find((key) =>
            error.serverError!.startsWith(key),
          );

          if (code) {
            const { title, ctaLabel, ctaUrl } = ERROR_MAP[code];
            const message = error.serverError!.replace(`${code}: `, "");

            toast.custom(() => (
              <UpgradeRequiredToast
                title={title}
                message={message}
                ctaLabel={ctaLabel}
                ctaUrl={ctaUrl}
              />
            ));
            return;
          }
        }

        toast.error(error.serverError);
      },
    },
  );

  const { executeAsync: updateDiscount, isPending: isUpdating } = useAction(
    updateDiscountAction,
    {
      onSuccess: async () => {
        setIsOpen(false);
        toast.success("Discount updated!");
        await mutateProgram();
        await mutateGroup();
        await mutatePrefix([
          "/api/groups",
          "/api/programs",
          "/api/partners",
          "/api/discount-codes",
        ]);
      },
      onError({ error }) {
        toast.error(error.serverError);
      },
    },
  );

  const { executeAsync: deleteDiscount, isPending: isDeleting } = useAction(
    deleteDiscountAction,
    {
      onSuccess: async () => {
        setIsOpen(false);
        toast.success("Discount deleted!");
        await mutate(`/api/programs/${defaultProgramId}`);
        await mutateGroup();
        await mutatePrefix([
          "/api/groups",
          "/api/programs",
          "/api/partners",
          "/api/discount-codes",
        ]);
      },
      onError({ error }) {
        toast.error(error.serverError);
      },
    },
  );

  const onSubmit = async (data: FormData) => {
    if (!workspaceId || !defaultProgramId || !group) {
      return;
    }

    if (discount) {
      await updateDiscount({
        workspaceId,
        discountId: discount.id,
        couponId: data.couponId,
        couponTestId: data.couponTestId,
        autoProvision: data.autoProvision,
      });
      return;
    }

    const isShopify =
      (data.provider ?? effectiveProvider) === DiscountProvider.shopify;
    const currentShopifyType = data.shopifyDiscountType || "amount_off_order";

    let calculatedAmount =
      data.type === "flat" ? (data.amount || 0) * 100 : data.amount || 0;
    if (isShopify) {
      if (currentShopifyType === "free_shipping") {
        calculatedAmount = 0;
      } else if (currentShopifyType === "bxgy") {
        calculatedAmount =
          data.bxgy?.discountType === "amount"
            ? (data.bxgy.discountValue || 0) * 100
            : data.bxgy?.discountValue || 100;
      }
    }

    const shopifyConfig = isShopify
      ? {
          type: currentShopifyType,
          productIds: data.productIds || [],
          collectionIds: data.collectionIds || [],
          bxgy:
            currentShopifyType === "bxgy"
              ? {
                  buyQuantity: Number(data.bxgy?.buyQuantity) || 1,
                  getQuantity: Number(data.bxgy?.getQuantity) || 1,
                  discountType: data.bxgy?.discountType || "percentage",
                  discountValue: Number(data.bxgy?.discountValue) || 100,
                }
              : undefined,
          freeShipping:
            currentShopifyType === "free_shipping"
              ? {
                  minimumSubtotal: data.freeShipping?.minimumSubtotal
                    ? Number(data.freeShipping.minimumSubtotal) * 100
                    : undefined,
                  maximumShippingPrice: data.freeShipping?.maximumShippingPrice
                    ? Number(data.freeShipping.maximumShippingPrice) * 100
                    : undefined,
                }
              : undefined,
        }
      : undefined;

    await createDiscount({
      ...data,
      workspaceId,
      groupId: group.id,
      amount: calculatedAmount,
      maxDuration:
        Number(data.maxDuration) === Infinity ? null : data.maxDuration,
      shopifyDiscountType: isShopify ? currentShopifyType : undefined,
      shopifyConfig,
      productIds: isShopify ? data.productIds : undefined,
      collectionIds: isShopify ? data.collectionIds : undefined,
      bxgy: isShopify && currentShopifyType === "bxgy" ? data.bxgy : undefined,
      freeShipping:
        isShopify && currentShopifyType === "free_shipping"
          ? data.freeShipping
          : undefined,
    });
  };

  const onDelete = async () => {
    if (!workspaceId || !defaultProgramId || !discount) {
      return;
    }

    if (!confirm("Are you sure you want to delete this discount?")) {
      return;
    }

    await deleteDiscount({
      workspaceId,
      discountId: discount.id,
    });
  };

  const isSubmitDisabled = () => {
    if (isDeleting || isCreating || isUpdating) return true;
    if (discount) return !isDirty;

    if (effectiveProvider === DiscountProvider.shopify) {
      if (effectiveShopifyType === "free_shipping") {
        return false;
      }
      if (effectiveShopifyType === "bxgy") {
        return !bxgy?.buyQuantity || !bxgy?.getQuantity;
      }
      return amount == null || amount <= 0;
    }

    return amount == null;
  };

  return (
    <FormProvider {...form}>
      <form
        ref={formRef}
        onSubmit={handleSubmit(onSubmit)}
        className="flex h-full flex-col"
      >
        <div className="flex h-16 items-center justify-between border-b border-neutral-200 px-6 py-4">
          <Sheet.Title className="text-lg font-semibold">
            {discount ? "Edit" : "Create"} discount
          </Sheet.Title>
          <Sheet.Description className="sr-only">
            Configure the discount provider, customer benefit, and partner code
            distribution.
          </Sheet.Description>
          <Sheet.Close asChild>
            <Button
              variant="outline"
              icon={<X className="size-5" />}
              className="h-auto w-fit p-1"
              aria-label="Close discount editor"
            />
          </Sheet.Close>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto p-6">
          <DiscountSheetCard
            title={
              <>
                {effectiveProvider === DiscountProvider.shopify ? (
                  <Shopify className="h-6 w-auto" />
                ) : (
                  <StripeIcon className="size-5" />
                )}
                <span className="leading-relaxed">
                  {effectiveProvider === DiscountProvider.shopify
                    ? "Shopify connection"
                    : "Stripe connection"}
                </span>
              </>
            }
            content={
              <div className="border-border-subtle -mx-px rounded-xl border-x border-t bg-neutral-100 p-2.5">
                <div className="space-y-4">
                  {isEdit ? (
                    <div className="rounded-lg border border-neutral-200 bg-white p-3">
                      <dl className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
                        <ConnectionDetail
                          label="Provider"
                          value={providerName}
                        />
                        {effectiveProvider === DiscountProvider.shopify && (
                          <ConnectionDetail
                            label="Store"
                            value={shopifyStoreId || "Not connected"}
                          />
                        )}
                        <ConnectionDetail
                          label="Campaign"
                          value={linkedCouponId || "Not linked"}
                          monospace={Boolean(linkedCouponId)}
                        />
                        <ConnectionDetail
                          label="Connection"
                          value={linkedCouponId ? "Linked" : "Not linked"}
                          status={linkedCouponId ? "positive" : "neutral"}
                        />
                      </dl>

                      <div className="mt-3 border-t border-neutral-100 pt-3">
                        <p className="text-xs leading-5 text-neutral-500">
                          The provider is fixed after this discount is created.
                          Campaign rules and customer eligibility remain managed
                          in {providerName}.
                        </p>

                        {effectiveProvider === DiscountProvider.shopify && (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              text={
                                isChangingShopifyCampaign
                                  ? "Cancel change"
                                  : linkedCouponId
                                    ? "Change campaign"
                                    : "Link campaign"
                              }
                              className="h-8 w-fit px-2.5"
                              onClick={() => {
                                if (isChangingShopifyCampaign) {
                                  resetField("couponId", {
                                    defaultValue: discount?.couponId || "",
                                  });
                                }
                                setIsChangingShopifyCampaign(
                                  !isChangingShopifyCampaign,
                                );
                              }}
                            />
                            {shopifyAdminDiscountUrl && (
                              <a
                                href={shopifyAdminDiscountUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                              >
                                <span>Open in Shopify Admin</span>
                                <ArrowUpRight className="size-3.5" />
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor="provider"
                        className="text-content-emphasis text-sm font-medium"
                      >
                        Discount provider
                      </label>
                      <div className="">
                        <select
                          className="block w-full rounded-md border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 disabled:cursor-not-allowed disabled:bg-neutral-50"
                          {...(() => {
                            const { onChange: onProviderChange, ...rest } =
                              register("provider", {
                                disabled: isEdit,
                              });

                            return {
                              ...rest,
                              onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                                onProviderChange(e);
                                if (
                                  e.target.value === DiscountProvider.shopify
                                ) {
                                  setUseExistingCoupon(true);
                                  setUseStripeTestCouponId(false);
                                  setValue("couponId", "");
                                  setValue("couponTestId", "");
                                } else {
                                  setUseExistingCoupon(false);
                                  setUseStripeTestCouponId(false);
                                  setValue("couponId", "");
                                  setValue("couponTestId", "");
                                }
                              },
                            };
                          })()}
                          id="provider"
                        >
                          <option value={DiscountProvider.stripe}>
                            Stripe
                          </option>
                          <option value={DiscountProvider.shopify}>
                            Shopify
                          </option>
                        </select>
                      </div>
                    </div>
                  )}

                  {!isEdit && effectiveProvider === DiscountProvider.stripe && (
                    <div className="grid grid-cols-1 gap-3 p-px lg:grid-cols-2">
                      {COUPON_CREATION_OPTIONS.map(
                        ({ label, description, useExisting }) => {
                          const isSelected = useExistingCoupon === useExisting;

                          return (
                            <label
                              key={label}
                              className={cn(
                                "relative flex w-full cursor-pointer items-start gap-0.5 rounded-md border border-neutral-200 bg-white p-3 text-neutral-600 hover:bg-neutral-50",
                                "transition-all duration-150",
                                isSelected &&
                                  "border-black bg-neutral-50 text-neutral-900 ring-1 ring-black",
                              )}
                            >
                              <input
                                type="radio"
                                value={label}
                                className="hidden"
                                checked={isSelected}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setUseExistingCoupon(useExisting);
                                    if (!useExisting) {
                                      setValue("couponId", "");
                                      setValue("couponTestId", "");
                                      setUseStripeTestCouponId(false);
                                    }
                                  }
                                }}
                              />
                              <div className="flex grow flex-col text-sm">
                                <span className="font-medium">{label}</span>
                                <span>{description}</span>
                              </div>
                              <CircleCheck
                                variant="fill"
                                className={cn(
                                  "-mr-px -mt-px flex size-4 scale-75 items-center justify-center rounded-full opacity-0 transition-[transform,opacity] duration-150",
                                  isSelected && "scale-100 opacity-100",
                                )}
                              />
                            </label>
                          );
                        },
                      )}
                    </div>
                  )}

                  {showStripeCouponFields && (
                    <>
                      <div>
                        <label
                          htmlFor="couponId"
                          className="flex items-center space-x-2"
                        >
                          <h2 className="text-sm font-medium text-neutral-900">
                            Stripe coupon ID
                          </h2>
                        </label>
                        <div className="mt-2">
                          <input
                            type="text"
                            id="couponId"
                            className="border-border-subtle block w-full rounded-lg bg-white px-3 py-2 text-neutral-800 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
                            {...register("couponId")}
                            placeholder="XZuejd0Q"
                            disabled={isEdit}
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <Switch
                          fn={(checked) => {
                            setUseStripeTestCouponId(checked);
                            if (!checked) {
                              setValue("couponTestId", "");
                            }
                          }}
                          checked={useStripeTestCouponId}
                          trackDimensions="w-8 h-4"
                          thumbDimensions="w-3 h-3"
                          thumbTranslate="translate-x-4"
                        />
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-medium text-neutral-800">
                            Use Stripe test coupon ID
                          </h3>

                          <InfoTooltip content="Enabling this will allow you to test your coupon code before going live by entering your Stripe test coupon ID." />
                        </div>
                      </div>

                      {useStripeTestCouponId && (
                        <div>
                          <label
                            htmlFor="couponTestId"
                            className="flex items-center space-x-2"
                          >
                            <h2 className="text-sm font-medium text-neutral-900">
                              Stripe test coupon ID
                            </h2>
                          </label>
                          <div className="mt-2">
                            <input
                              type="text"
                              id="couponTestId"
                              className="border-border-subtle block w-full rounded-lg px-3 py-2 text-neutral-800 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
                              {...register("couponTestId")}
                              placeholder="2NMXz81x"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {showShopifyCouponFields && (
                    <div>
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="shopifyCouponId"
                          className="flex items-center space-x-2"
                        >
                          <h2 className="text-sm font-medium text-neutral-900">
                            {isEdit
                              ? "New Shopify discount code or ID"
                              : "Shopify discount code or ID"}
                          </h2>
                          <InfoTooltip content="Enter the code (e.g. DEMO10, SUMMER20) or numeric GID of the parent discount campaign configured in Shopify Admin. Partner links in this group will generate codes under this campaign." />
                        </label>

                        {shopifyAdminDiscountUrl && !isEdit && (
                          <a
                            href={shopifyAdminDiscountUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
                          >
                            <span>Open in Shopify Admin</span>
                            <ArrowUpRight className="size-3.5" />
                          </a>
                        )}
                      </div>
                      <div className="mt-2">
                        <input
                          type="text"
                          id="shopifyCouponId"
                          className="border-border-subtle block w-full rounded-lg bg-white px-3 py-2 text-neutral-800 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm"
                          {...register("couponId")}
                          placeholder="e.g. SUMMER20 or gid://shopify/DiscountCodeNode/..."
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            }
          />

          {isEdit && (
            <>
              <VerticalLine />
              <DiscountSheetCard
                title={
                  <>
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-neutral-100">
                      <Tag className="size-4 text-neutral-800" />
                    </div>
                    <span className="font-medium leading-relaxed">
                      Customer discount
                    </span>
                  </>
                }
                content={
                  <div className="space-y-3 border-t border-neutral-200 p-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-5 text-neutral-900">
                        {customerDiscountBenefit}
                      </p>
                      <p className="text-xs leading-5 text-neutral-500">
                        {customerDiscountScope}
                      </p>
                    </div>

                    <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-xs leading-5 text-neutral-600">
                      <CircleInfo className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />
                      <p>
                        Customers receive this benefit using codes issued to
                        partners. Customer eligibility and campaign rules are
                        managed in {providerName}.
                      </p>
                    </div>
                  </div>
                }
              />
            </>
          )}

          {!isUsingExistingCoupon &&
            effectiveProvider === DiscountProvider.stripe && (
              <>
                <VerticalLine />

                <Tooltip
                  content="To change the conditions, delete the discount and create a new one."
                  side="top"
                  disabled={!isEdit}
                >
                  <div>
                    <DiscountSheetCard
                      className={cn(isEdit && "cursor-not-allowed select-none")}
                      title={
                        <>
                          <StripeIcon className="size-7" />
                          <span className="leading-relaxed">
                            Discount a{" "}
                            <InlineBadgePopover
                              text={capitalize(type)}
                              disabled={isEdit}
                            >
                              <InlineBadgePopoverMenu
                                selectedValue={type}
                                onSelect={(value) =>
                                  setValue(
                                    "type",
                                    value as "flat" | "percentage",
                                    {
                                      shouldDirty: true,
                                    },
                                  )
                                }
                                items={[
                                  {
                                    text: "Flat",
                                    value: "flat",
                                  },
                                  {
                                    text: "Percentage",
                                    value: "percentage",
                                  },
                                ]}
                              />
                            </InlineBadgePopover>{" "}
                            {type === "percentage" && "of "}
                            <InlineBadgePopover
                              text={
                                amount
                                  ? constructDiscountAmount({
                                      amount:
                                        type === "flat" ? amount * 100 : amount,
                                      type,
                                    })
                                  : "amount"
                              }
                              invalid={!amount}
                              disabled={isEdit}
                            >
                              <AmountInput disabled={isEdit} />
                            </InlineBadgePopover>{" "}
                            <InlineBadgePopover
                              text={
                                maxDuration === 0
                                  ? "one time"
                                  : maxDuration === Infinity
                                    ? "for the customer's lifetime"
                                    : `for ${maxDuration} ${pluralize("month", Number(maxDuration))}`
                              }
                              disabled={isEdit}
                            >
                              <DurationPopoverContent
                                value={Number(maxDuration)}
                                onChange={(value) =>
                                  setValue("maxDuration", value, {
                                    shouldDirty: true,
                                  })
                                }
                                presetDurations={RECURRING_MAX_DURATIONS}
                              />
                            </InlineBadgePopover>
                          </span>
                        </>
                      }
                      content={<></>}
                    />
                  </div>
                </Tooltip>
              </>
            )}

          <VerticalLine />

          <div className="border-border-subtle rounded-xl border bg-white p-3 text-sm shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-neutral-900">
                    Partner code distribution
                  </h3>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                      autoProvision
                        ? "bg-green-100 text-green-700"
                        : "bg-neutral-100 text-neutral-600",
                    )}
                  >
                    {autoProvision && <CircleCheck className="size-3" />}
                    {autoProvision ? "On" : "Off"}
                  </span>
                </div>
                <p className="text-xs leading-5 text-neutral-500">
                  {autoProvision
                    ? "Create codes for current partners and automatically provision codes for future partners joining this group."
                    : "Codes are not automatically created for current or future partners in this group."}
                </p>
              </div>

              {!isEdit && (
                <Switch
                  fn={(checked) =>
                    setValue("autoProvision", checked, { shouldDirty: true })
                  }
                  checked={autoProvision}
                  trackDimensions="w-8 h-4"
                  thumbDimensions="w-3 h-3"
                  thumbTranslate="translate-x-4"
                />
              )}
            </div>
          </div>

          <VerticalLine />

          {group && (
            <RewardDiscountPartnersCard
              groupId={group.id}
              label="Codes for"
              emptyLabel="No partners in this group"
              suffix={`in ${group.name}`}
              showPreviewAvatars={false}
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 p-5">
          <div>
            {discount && (
              <Button
                type="button"
                variant="outline"
                text="Remove discount"
                onClick={onDelete}
                loading={isDeleting}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsOpen(false)}
              text="Cancel"
              className="w-fit"
              disabled={isCreating || isDeleting || isUpdating}
            />

            <Button
              type="submit"
              variant="primary"
              text={discount ? "Update discount" : "Create discount"}
              className="w-fit"
              loading={isCreating || isUpdating}
              disabled={isSubmitDisabled()}
            />
          </div>
        </div>
      </form>
    </FormProvider>
  );
}

function ConnectionDetail({
  label,
  value,
  monospace = false,
  status,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  status?: "positive" | "neutral";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 flex min-w-0 items-center gap-1.5 text-sm font-medium text-neutral-900",
          status === "positive" && "text-green-700",
          status === "neutral" && "text-neutral-600",
          monospace && "font-mono text-xs",
        )}
      >
        {status === "positive" && <CircleCheck className="size-3.5 shrink-0" />}
        <span className="truncate" title={value}>
          {value}
        </span>
      </dd>
    </div>
  );
}

function DiscountSheetCard({
  title,
  content,
  className,
}: PropsWithChildren<{
  title: ReactNode;
  content: ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        "border-border-subtle rounded-xl border bg-white text-sm shadow-sm",
        className,
      )}
    >
      <div className="text-content-emphasis flex items-center gap-2.5 p-2.5 font-medium">
        {title}
      </div>
      {content && <>{content}</>}
    </div>
  );
}

const VerticalLine = () => (
  <div className="bg-border-subtle ml-6 h-4 w-px shrink-0" />
);

function AmountInput({ disabled }: { disabled?: boolean }) {
  const { watch, register } = useAddEditDiscountForm();
  const type = watch("type");

  return (
    <div className="relative rounded-md shadow-sm">
      {type === "flat" && (
        <span className="absolute inset-y-0 left-0 flex items-center pl-1.5 text-sm text-neutral-400">
          $
        </span>
      )}
      <input
        className={cn(
          "block w-full rounded-md border-neutral-300 px-1.5 py-1 text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm",
          type === "flat" ? "pl-4 pr-12" : "pr-7",
        )}
        disabled={disabled}
        {...register("amount", {
          required: true,
          setValueAs: (value: string) => (value === "" ? undefined : +value),
          min: 0,
          max: type === "percentage" ? 100 : undefined,
          onChange: handleMoneyInputChange,
        })}
        onKeyDown={handleMoneyKeyDown}
      />
      <span className="absolute inset-y-0 right-0 flex items-center pr-1.5 text-sm text-neutral-400">
        {type === "flat" ? "USD" : "%"}
      </span>
    </div>
  );
}

export function DiscountSheet({
  isOpen,
  nested,
  ...rest
}: DiscountSheetProps & {
  isOpen: boolean;
  nested?: boolean;
}) {
  const { queryParams } = useRouterStuff();

  const setIsOpen: DiscountSheetProps["setIsOpen"] = (value) => {
    const nextOpen = typeof value === "function" ? value(isOpen) : value;
    rest.setIsOpen(value);
    if (!nextOpen) {
      queryParams({ del: "discountId", scroll: false });
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen} nested={nested}>
      <DiscountSheetContent {...rest} setIsOpen={setIsOpen} />
    </Sheet>
  );
}

export function useDiscountSheet(
  props: { nested?: boolean } & Omit<DiscountSheetProps, "setIsOpen">,
) {
  const [isOpen, setIsOpen] = useState(false);

  return {
    DiscountSheet: (
      <DiscountSheet setIsOpen={setIsOpen} isOpen={isOpen} {...props} />
    ),
    setIsOpen,
  };
}
