"use client";

import usePartnerProfile from "@/lib/swr/use-partner-profile";
import useProgramEnrollment from "@/lib/swr/use-program-enrollment";
import {
  useWeleticProducts,
  WeleticCatalogProduct,
} from "@/lib/swr/use-weletic-products";
import {
  getWeleticMessage,
  WELETIC_LOCALES,
  WeleticLocale,
} from "@/lib/weletic/localization";
import { getCatalogPricing } from "@/lib/weletic/money";
import {
  getPartnerCatalogPreferences,
  savePartnerCatalogPreferences,
} from "@/lib/weletic/partner-preferences";
import { BlurImage, PaginationControls, usePagination } from "@dub/ui";
import { ChevronDown, Eye, Search } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";
import { ProductOfferLinkModal } from "./product-offer-link-modal";

const localeLabels: Record<WeleticLocale, string> = {
  en: "English",
  vi: "Tiếng Việt",
  ja: "日本語",
};

const catalogI18n: Record<
  WeleticLocale,
  {
    title: string;
    subtitle: string;
    marketLabel: string;
    countryLabel: string;
    languageLabel: string;
    searchPlaceholder: string;
    emptyMessage: string;
    getLink: string;
    details: string;
    commissionLabel: string;
    discountLabel: string;
    productUnit: (p?: boolean) => string;
    categories: {
      all: string;
      xtra: string;
      shoes: string;
      apparel: string;
      accessories: string;
    };
  }
> = {
  en: {
    title: "Product Offers",
    subtitle:
      "Explore product catalog and generate affiliate links to earn commission",
    marketLabel: "Market",
    countryLabel: "Country",
    languageLabel: "Language",
    searchPlaceholder: "Search for all Store Products...",
    emptyMessage: "No products match your selected filters.",
    getLink: "Get Link",
    details: "Details",
    commissionLabel: "Commission",
    discountLabel: "Discount",
    productUnit: (p) => `product${p ? "s" : ""}`,
    categories: {
      all: "All",
      xtra: "Commissions XTRA",
      shoes: "Shoes & Footwear",
      apparel: "Clothing & Tops",
      accessories: "Accessories & Bags",
    },
  },
  vi: {
    title: "Danh mục sản phẩm",
    subtitle:
      "Khám phá danh mục sản phẩm và lấy link tiếp thị liên kết (Affiliate Links) nhận hoa hồng",
    marketLabel: "Thị trường",
    countryLabel: "Quốc gia",
    languageLabel: "Ngôn ngữ",
    searchPlaceholder: "Tìm kiếm sản phẩm trong cửa hàng...",
    emptyMessage: "Không tìm thấy sản phẩm phù hợp với bộ lọc.",
    getLink: "Lấy link",
    details: "Chi tiết",
    commissionLabel: "Hoa hồng",
    discountLabel: "Mã giảm",
    productUnit: () => "sản phẩm",
    categories: {
      all: "Tất cả",
      xtra: "Hoa hồng XTRA",
      shoes: "Giày dép",
      apparel: "Quần áo",
      accessories: "Phụ kiện & Túi",
    },
  },
  ja: {
    title: "商品オファー",
    subtitle:
      "商品カタログを閲覧し、アフィリエイトリンクを取得して報酬を獲得します",
    marketLabel: "マーケット",
    countryLabel: "国",
    languageLabel: "言語",
    searchPlaceholder: "ストア内の商品を検索...",
    emptyMessage: "条件に一致する商品が見つかりませんでした。",
    getLink: "リンク取得",
    details: "詳細",
    commissionLabel: "報酬",
    discountLabel: "割引",
    productUnit: () => "件の商品",
    categories: {
      all: "すべて",
      xtra: "高コミッション",
      shoes: "シューズ",
      apparel: "アパレル",
      accessories: "アクセサリー",
    },
  },
};

function CatalogSkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5">
      {Array.from({ length: 15 }).map((_, idx) => (
        <div
          key={idx}
          className="flex flex-col justify-between overflow-hidden rounded-xl border border-neutral-200 bg-white"
        >
          {/* Square Image Placeholder 1:1 */}
          <div className="aspect-square w-full animate-pulse bg-neutral-100" />
          {/* Content lines */}
          <div className="space-y-2 p-3.5">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-neutral-200" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
            <div className="flex gap-1.5 pt-1">
              <div className="h-5 w-16 animate-pulse rounded bg-neutral-100" />
              <div className="h-5 w-14 animate-pulse rounded bg-neutral-100" />
            </div>
            <div className="h-4 w-20 animate-pulse rounded bg-neutral-200" />
          </div>
          {/* Button placeholder */}
          <div className="p-3.5 pt-0">
            <div className="h-7 w-full animate-pulse rounded-lg bg-neutral-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function WeleticProductsPageClient() {
  const { programSlug } = useParams();
  const { programEnrollment } = useProgramEnrollment();
  const { partner } = usePartnerProfile();

  const effectiveProgramId = (programEnrollment?.programId || programSlug) as
    | string
    | undefined;

  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebounce(search, 350);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [marketId, setMarketId] = useState<string | undefined>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.marketId;
  });
  const [countryCode, setCountryCode] = useState<string | undefined>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.countryCode;
  });
  const [locale, setLocale] = useState<WeleticLocale>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.locale || "en";
  });
  const { pagination, setPagination } = usePagination(25);

  // Modals state
  const [offerLinkProduct, setOfferLinkProduct] =
    useState<WeleticCatalogProduct | null>(null);
  const [detailProduct, setDetailProduct] =
    useState<WeleticCatalogProduct | null>(null);

  // Derive effective search query sent to backend API
  const effectiveQuery = useMemo(() => {
    const term = debouncedSearch.trim();
    if (selectedCategory === "shoes") {
      return term ? `${term} shoe` : "shoe";
    }
    if (selectedCategory === "apparel") {
      return term ? `${term} apparel` : "apparel";
    }
    if (selectedCategory === "accessories") {
      return term ? `${term} accessory` : "accessory";
    }
    return term || undefined;
  }, [debouncedSearch, selectedCategory]);

  const { data, error, loading } = useWeleticProducts({
    programId: effectiveProgramId,
    q: effectiveQuery,
    marketId,
    countryCode,
    locale,
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
  });

  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 1 }));
  }, [
    effectiveQuery,
    marketId,
    countryCode,
    locale,
    selectedCategory,
    setPagination,
  ]);

  useEffect(() => {
    const saved = getPartnerCatalogPreferences(effectiveProgramId);
    if (!saved?.locale && partner?.preferredLocale) {
      setLocale(partner.preferredLocale);
    }
  }, [partner?.preferredLocale, effectiveProgramId]);

  useEffect(() => {
    if (!data?.markets.length) return;
    const saved = getPartnerCatalogPreferences(effectiveProgramId);

    if (!marketId || !data.markets.some((m) => m.id === marketId)) {
      const preferredMarket =
        (saved?.marketId &&
          data.markets.find((m) => m.id === saved.marketId)) ||
        data.markets.find((market) =>
          market.countryCodes.includes(partner?.country ?? ""),
        ) ||
        data.markets.find((market) => market.primary) ||
        data.markets[0];

      if (preferredMarket) {
        setMarketId(preferredMarket.id);
        const countries = preferredMarket.countryCodes ?? [];
        const preferredCountry =
          (saved?.countryCode &&
            countries.includes(saved.countryCode) &&
            saved.countryCode) ||
          countries[0];
        setCountryCode(preferredCountry);
        savePartnerCatalogPreferences(effectiveProgramId, {
          marketId: preferredMarket.id,
          countryCode: preferredCountry,
        });
      }
    }
  }, [data?.markets, marketId, partner?.country, effectiveProgramId]);

  const selectedMarket = data?.markets.find((market) => market.id === marketId);

  useEffect(() => {
    if (!selectedMarket) return;
    const countries = selectedMarket.countryCodes ?? [];
    if (!countryCode || !countries.includes(countryCode)) {
      const fallbackCountry = countries[0];
      setCountryCode(fallbackCountry);
      savePartnerCatalogPreferences(effectiveProgramId, {
        countryCode: fallbackCountry,
      });
    }
  }, [selectedMarket, countryCode, effectiveProgramId]);

  const t = catalogI18n[locale] || catalogI18n.en;

  // Extract unique categories from current products
  const categories = useMemo(
    () => [
      { id: "all", label: t.categories.all },
      { id: "xtra", label: t.categories.xtra },
      { id: "shoes", label: t.categories.shoes },
      { id: "apparel", label: t.categories.apparel },
      { id: "accessories", label: t.categories.accessories },
    ],
    [t],
  );

  // Filter products by category tab
  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    if (selectedCategory === "all") return data.products;
    if (selectedCategory === "xtra") {
      return data.products.filter(
        (p) => (p.commission?.basisPoints ?? 0) >= 1000,
      );
    }
    if (selectedCategory === "shoes") {
      return data.products.filter(
        (p) =>
          p.productType?.toLowerCase().includes("shoe") ||
          p.title.toLowerCase().includes("shoe") ||
          p.title.toLowerCase().includes("converse") ||
          p.title.toLowerCase().includes("martens") ||
          p.title.toLowerCase().includes("vans") ||
          p.title.toLowerCase().includes("stan smith"),
      );
    }
    if (selectedCategory === "apparel") {
      return data.products.filter(
        (p) =>
          p.productType?.toLowerCase().includes("clothing") ||
          p.productType?.toLowerCase().includes("apparel") ||
          p.title.toLowerCase().includes("tee") ||
          p.title.toLowerCase().includes("shirt") ||
          p.title.toLowerCase().includes("short") ||
          p.title.toLowerCase().includes("legging"),
      );
    }
    if (selectedCategory === "accessories") {
      return data.products.filter(
        (p) =>
          p.productType?.toLowerCase().includes("accessories") ||
          p.title.toLowerCase().includes("cap") ||
          p.title.toLowerCase().includes("backpack") ||
          p.title.toLowerCase().includes("sock") ||
          p.title.toLowerCase().includes("bag") ||
          p.title.toLowerCase().includes("iona"),
      );
    }
    return data.products;
  }, [data?.products, selectedCategory]);

  const totalPages = data?.pagination.totalPages ?? 1;
  const totalProducts = useMemo(() => {
    if (!data) return 0;
    if (selectedCategory === "xtra") {
      return filteredProducts.length;
    }
    return data.pagination.total;
  }, [data, selectedCategory, filteredProducts.length]);

  return (
    <div className="space-y-6">
      {/* Header Banner / Top Controls */}
      <div className="shadow-xs space-y-4 rounded-2xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold text-neutral-900">{t.title}</h1>
            <p className="mt-0.5 text-xs text-neutral-500">{t.subtitle}</p>
          </div>

          {/* Market & Language selector */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative inline-flex items-center">
              <select
                aria-label={t.marketLabel}
                value={marketId ?? ""}
                onChange={(e) => {
                  const val = e.target.value || undefined;
                  setMarketId(val);
                  const m = data?.markets.find((item) => item.id === val);
                  const newCountry = m?.countryCodes[0];
                  if (newCountry) setCountryCode(newCountry);
                  savePartnerCatalogPreferences(effectiveProgramId, {
                    marketId: val,
                    countryCode: newCountry,
                  });
                }}
                className="shadow-xs h-8 cursor-pointer appearance-none rounded-lg border border-neutral-200 bg-white pl-3 pr-8 text-xs font-medium text-neutral-700 outline-none hover:bg-neutral-50 focus:border-neutral-400"
              >
                {data?.markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-neutral-400" />
            </div>

            <div className="relative inline-flex items-center">
              <select
                aria-label={t.countryLabel}
                value={countryCode ?? ""}
                onChange={(e) => {
                  const val = e.target.value || undefined;
                  setCountryCode(val);
                  savePartnerCatalogPreferences(effectiveProgramId, {
                    countryCode: val,
                  });
                }}
                className="shadow-xs h-8 cursor-pointer appearance-none rounded-lg border border-neutral-200 bg-white pl-3 pr-8 text-xs font-medium text-neutral-700 outline-none hover:bg-neutral-50 focus:border-neutral-400"
              >
                {(selectedMarket?.countryCodes ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-neutral-400" />
            </div>

            <div className="relative inline-flex items-center">
              <select
                aria-label={t.languageLabel}
                value={locale}
                onChange={(e) => {
                  const val = e.target.value as WeleticLocale;
                  setLocale(val);
                  savePartnerCatalogPreferences(effectiveProgramId, {
                    locale: val,
                  });
                }}
                className="shadow-xs h-8 cursor-pointer appearance-none rounded-lg border border-neutral-200 bg-white pl-3 pr-8 text-xs font-medium text-neutral-700 outline-none hover:bg-neutral-50 focus:border-neutral-400"
              >
                {WELETIC_LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {localeLabels[l]}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-neutral-400" />
            </div>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="shadow-xs h-9 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-500"
          />
        </div>

        {/* Categories Navigation Bar */}
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto border-t border-neutral-100 pt-3">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                selectedCategory === cat.id
                  ? "shadow-xs bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200/80"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid Content */}
      {loading && !data ? (
        <CatalogSkeletonGrid />
      ) : error ? (
        <EmptyCatalog
          message={getWeleticMessage(locale, "catalog.loadError")}
        />
      ) : !filteredProducts.length ? (
        <EmptyCatalog message={t.emptyMessage} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5">
            {filteredProducts.map((product) => (
              <ShopeeProductCard
                key={product.id}
                product={product}
                programSlug={programSlug as string}
                locale={locale}
                t={t}
                onGetLink={() => setOfferLinkProduct(product)}
              />
            ))}
          </div>

          {/* Marketplace-style sticky bottom PaginationControls */}
          <div className="sticky bottom-0 mt-4 rounded-b-[inherit] border-t border-neutral-200 bg-white px-3.5 py-2">
            <PaginationControls
              pagination={pagination}
              setPagination={setPagination}
              totalCount={totalProducts}
              unit={t.productUnit}
            />
          </div>
        </>
      )}

      {/* Product Offer Link Modal (Hình 1 & Hình 2) */}
      <ProductOfferLinkModal
        showModal={Boolean(offerLinkProduct)}
        setShowModal={(show) => !show && setOfferLinkProduct(null)}
        product={offerLinkProduct}
        programId={effectiveProgramId!}
        marketId={marketId}
        countryCode={countryCode}
        locale={locale}
      />
    </div>
  );
}

export function WeleticProductsTitle() {
  const { partner } = usePartnerProfile();
  return getWeleticMessage(partner?.preferredLocale, "catalog.title");
}

function ShopeeProductCard({
  product,
  programSlug,
  locale,
  t,
  onGetLink,
}: {
  product: WeleticCatalogProduct;
  programSlug: string;
  locale: WeleticLocale;
  t: (typeof catalogI18n)["en"];
  onGetLink: () => void;
}) {
  const defaultVariant = product.variants[0];

  const pricing = defaultVariant
    ? getCatalogPricing({
        amount: defaultVariant.amount,
        compareAtAmount: defaultVariant.compareAtAmount,
        currency: defaultVariant.currency,
        locale,
      })
    : {
        hasDiscount: false,
        discountPercent: 0,
        formattedPrice: "—",
        formattedCompareAtPrice: null,
        badgeText: null,
      };

  const commRatePercent = product.commission?.basisPoints
    ? `${(product.commission.basisPoints / 100).toFixed(0)}%`
    : product.commission?.fixedAmount
      ? "Fixed"
      : "10%";

  return (
    <article className="group flex flex-col justify-between overflow-hidden rounded-xl border border-neutral-200 bg-white transition hover:border-neutral-300 hover:shadow-md">
      {/* Clickable Area for Detail Page */}
      <Link
        href={`/programs/${programSlug}/products/${product.id}`}
        className="block cursor-pointer"
      >
        {/* Square Image 1:1 */}
        <div className="relative aspect-square w-full overflow-hidden border-b border-neutral-100 bg-neutral-50">
          {product.imageUrl ? (
            <BlurImage
              src={product.imageUrl}
              alt={product.title}
              fill
              className="object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">
              No image
            </div>
          )}

          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/10 group-hover:opacity-100">
            <span className="shadow-xs backdrop-blur-xs flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-xs font-medium text-neutral-900">
              <Eye className="h-3.5 w-3.5" />
              {t.details}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-2 p-3.5">
          {/* Title 2-line clamp */}
          <h3 className="line-clamp-2 text-xs font-medium leading-snug text-neutral-900 transition group-hover:text-neutral-700">
            {product.title}
          </h3>

          {/* HOA HỒNG & VOUCHER KHÁCH Badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex items-center gap-1 rounded-md border border-green-200/60 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
              <span>{t.commissionLabel}</span>
              <span className="font-semibold">{commRatePercent}</span>
            </div>

            {product.customerDiscount && (
              <div className="inline-flex items-center gap-1 rounded-md border border-indigo-200/60 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                <span>{t.discountLabel}</span>
                <span className="font-semibold">
                  {product.customerDiscount.formatted}
                </span>
              </div>
            )}
          </div>

          {/* Price & Compare-At */}
          <div className="flex flex-wrap items-baseline gap-1.5 pt-0.5">
            <span className="text-sm font-semibold text-neutral-900">
              {pricing.formattedPrice}
            </span>
            {pricing.hasDiscount && pricing.formattedCompareAtPrice && (
              <span className="text-xs text-neutral-400 line-through">
                {pricing.formattedCompareAtPrice}
              </span>
            )}
            {pricing.hasDiscount && pricing.badgeText && (
              <span className="rounded border border-rose-200/60 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                {pricing.badgeText}
              </span>
            )}
          </div>
        </div>
      </Link>

      {/* Card Action Bar */}
      <div className="p-3.5 pt-0">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onGetLink();
          }}
          className="shadow-xs w-full rounded-lg border border-neutral-200 bg-white py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-50"
        >
          {t.getLink}
        </button>
      </div>
    </article>
  );
}

function EmptyCatalog({ message }: { message: string }) {
  return (
    <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-neutral-50 text-sm text-neutral-500">
      {message}
    </div>
  );
}
