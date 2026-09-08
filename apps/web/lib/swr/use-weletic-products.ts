import { WeleticLocale } from "@/lib/weletic/localization";
import { fetcher } from "@dub/utils";
import useSWR from "swr";

export interface WeleticCatalogVariant {
  id: string;
  title: string;
  sku: string | null;
  imageUrl: string | null;
  amount: string;
  compareAtAmount: string | null;
  currency: string;
}

export interface WeleticCatalogProduct {
  id: string;
  externalId: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  variants: WeleticCatalogVariant[];
  commission: {
    ruleId: string;
    type: "percentage" | "fixed";
    basisPoints: number | null;
    fixedAmount: string | null;
    currency: string | null;
    minOrderAmount: string | null;
  } | null;
  customerDiscount?: {
    type: "percentage" | "flat";
    amount: number;
    formatted: string;
    couponCode: string | null;
  } | null;
}

export interface WeleticCatalogResponse {
  products: WeleticCatalogProduct[];
  markets: Array<{
    id: string;
    name: string;
    handle: string | null;
    countryCodes: string[];
    currencyCodes: string[];
    primary: boolean;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  locale: WeleticLocale;
  countryCode: string | null;
  accountingCurrency: string;
}

export function useWeleticProducts({
  programId,
  q,
  marketId,
  countryCode,
  locale,
  page = 1,
  pageSize = 25,
}: {
  programId?: string;
  q?: string;
  marketId?: string;
  countryCode?: string;
  locale: WeleticLocale;
  page?: number;
  pageSize?: number;
}) {
  const query = new URLSearchParams({
    locale,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (q) query.set("q", q);
  if (marketId) query.set("marketId", marketId);
  if (countryCode) query.set("countryCode", countryCode);

  const { data, error, isLoading, mutate } = useSWR<WeleticCatalogResponse>(
    programId
      ? `/api/partner-profile/programs/${programId}/products?${query}`
      : undefined,
    fetcher,
    { keepPreviousData: true },
  );

  return { data, error, loading: isLoading, mutate };
}

export function useWeleticProduct({
  programId,
  productId,
  marketId,
  countryCode,
  locale,
}: {
  programId?: string;
  productId?: string;
  marketId?: string;
  countryCode?: string;
  locale: WeleticLocale;
}) {
  const query = new URLSearchParams({
    locale,
  });
  if (marketId) query.set("marketId", marketId);
  if (countryCode) query.set("countryCode", countryCode);

  const { data, error, isLoading, mutate } = useSWR<{
    product: WeleticCatalogProduct;
    markets: Array<{
      id: string;
      name: string;
      handle: string | null;
      countryCodes: string[];
      currencies: string[];
      primary: boolean;
    }>;
  }>(
    programId && productId
      ? `/api/partner-profile/programs/${programId}/products/${productId}?${query}`
      : undefined,
    fetcher,
  );

  return {
    product: data?.product,
    markets: data?.markets,
    error,
    loading: isLoading,
    mutate,
  };
}
