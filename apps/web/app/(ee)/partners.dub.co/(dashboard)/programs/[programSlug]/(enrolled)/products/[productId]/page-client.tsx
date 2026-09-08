"use client";

import usePartnerProfile from "@/lib/swr/use-partner-profile";
import useProgramEnrollment from "@/lib/swr/use-program-enrollment";
import { useWeleticProduct } from "@/lib/swr/use-weletic-products";
import { WELETIC_LOCALES, WeleticLocale } from "@/lib/weletic/localization";
import {
  formatMoney,
  getCatalogPricing,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  getPartnerCatalogPreferences,
  savePartnerCatalogPreferences,
} from "@/lib/weletic/partner-preferences";
import { BlurImage, Button, LoadingSpinner } from "@dub/ui";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Globe,
  ShieldCheck,
  Star,
  Tag,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ProductOfferLinkModal } from "../product-offer-link-modal";

const localeLabels: Record<WeleticLocale, string> = {
  en: "English",
  vi: "Tiếng Việt",
  ja: "日本語",
};

export function WeleticProductDetailPageClient() {
  const { programSlug, productId } = useParams() as {
    programSlug: string;
    productId: string;
  };
  const { programEnrollment } = useProgramEnrollment();
  const { partner } = usePartnerProfile();
  const router = useRouter();

  const effectiveProgramId = (programEnrollment?.programId || programSlug) as
    | string
    | undefined;

  const [marketId, setMarketId] = useState<string | undefined>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.marketId;
  });
  const [countryCode, setCountryCode] = useState<string | undefined>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.countryCode;
  });
  const [locale, setLocale] = useState<WeleticLocale>(() => {
    return getPartnerCatalogPreferences(effectiveProgramId)?.locale || "en";
  });
  const [selectedVariantId, setSelectedVariantId] = useState<string>();
  const [showLinkModal, setShowLinkModal] = useState(false);

  const { product, markets, error, loading } = useWeleticProduct({
    programId: effectiveProgramId,
    productId,
    marketId,
    countryCode,
    locale,
  });

  useEffect(() => {
    const saved = getPartnerCatalogPreferences(effectiveProgramId);
    if (!saved?.locale && partner?.preferredLocale) {
      setLocale(partner.preferredLocale);
    }
  }, [partner?.preferredLocale, effectiveProgramId]);

  useEffect(() => {
    if (!markets?.length) return;
    const saved = getPartnerCatalogPreferences(effectiveProgramId);

    if (!marketId || !markets.some((m) => m.id === marketId)) {
      const preferredMarket =
        (saved?.marketId && markets.find((m) => m.id === saved.marketId)) ||
        markets.find((market) =>
          market.countryCodes.includes(partner?.country ?? ""),
        ) ||
        markets.find((market) => market.primary) ||
        markets[0];

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
  }, [markets, marketId, partner?.country, effectiveProgramId]);

  const selectedMarket = markets?.find((market) => market.id === marketId);

  const handleMarketChange = (newMarketId: string) => {
    setMarketId(newMarketId);
    const m = markets?.find((item) => item.id === newMarketId);
    const newCountry = m?.countryCodes[0];
    if (newCountry) {
      setCountryCode(newCountry);
    }
    savePartnerCatalogPreferences(effectiveProgramId, {
      marketId: newMarketId,
      countryCode: newCountry,
    });
  };

  const handleCountryCodeChange = (newCountryCode: string | undefined) => {
    setCountryCode(newCountryCode);
    savePartnerCatalogPreferences(effectiveProgramId, {
      countryCode: newCountryCode,
    });
  };

  const handleLocaleChange = (newLocale: WeleticLocale) => {
    setLocale(newLocale);
    savePartnerCatalogPreferences(effectiveProgramId, {
      locale: newLocale,
    });
  };

  useEffect(() => {
    if (product?.variants?.length) {
      setSelectedVariantId((prev) => prev || product.variants[0]?.id);
    }
  }, [product?.variants]);

  const currentVariant = useMemo(() => {
    if (!product?.variants?.length) return null;
    return (
      product.variants.find((v) => v.id === selectedVariantId) ||
      product.variants[0]
    );
  }, [product, selectedVariantId]);

  const pricing = currentVariant
    ? getCatalogPricing({
        amount: currentVariant.amount,
        compareAtAmount: currentVariant.compareAtAmount,
        currency: currentVariant.currency,
        locale,
      })
    : {
        hasDiscount: false,
        discountPercent: 0,
        formattedPrice: "",
        formattedCompareAtPrice: null,
        badgeText: null,
      };

  const commRatePercent = product?.commission?.basisPoints
    ? (product.commission.basisPoints / 100).toFixed(1)
    : "10.0";

  const rawBaseCommissionAmount =
    product?.commission?.type === "percentage" && currentVariant
      ? (BigInt(currentVariant.amount) *
          BigInt(product.commission.basisPoints ?? 1000)) /
        BigInt(10000)
      : BigInt(0);

  const formattedBaseCommission = currentVariant
    ? formatMoney(
        {
          amount: rawBaseCommissionAmount,
          currency: normalizeCurrency(currentVariant.currency),
        },
        locale,
      )
    : "";

  // Social bonus calculation
  const socialBonusAmount =
    (rawBaseCommissionAmount * BigInt(20)) / BigInt(100);
  const totalSocialCommission = rawBaseCommissionAmount + socialBonusAmount;

  const formattedSocialBonus = currentVariant
    ? formatMoney(
        {
          amount: socialBonusAmount,
          currency: normalizeCurrency(currentVariant.currency),
        },
        locale,
      )
    : "";

  const formattedTotalSocialCommission = currentVariant
    ? formatMoney(
        {
          amount: totalSocialCommission,
          currency: normalizeCurrency(currentVariant.currency),
        },
        locale,
      )
    : "";

  const commissionSource =
    (product?.commission as any)?.source === "product"
      ? "Cấu hình hoa hồng riêng cho sản phẩm (Custom Product Rule)"
      : "Áp dụng chính sách mặc định của Nhóm (Default Group Rule)";

  if (loading && !product) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="space-y-4">
        <Link
          href={`/programs/${programSlug}/products`}
          className="inline-flex items-center gap-2 text-sm font-medium text-neutral-600 transition hover:text-neutral-900"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Quay lại Danh sách Sản phẩm</span>
        </Link>
        <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
          <p className="text-sm font-medium text-neutral-600">
            Không tìm thấy thông tin sản phẩm yêu cầu.
          </p>
          <Button
            text="Quay lại danh mục"
            variant="secondary"
            className="mt-4"
            onClick={() => router.push(`/programs/${programSlug}/products`)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Breadcrumbs & Back Navigation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-neutral-500">
          <Link
            href={`/programs/${programSlug}/products`}
            className="flex items-center gap-1.5 transition hover:text-neutral-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Product Offers</span>
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />
          <span className="max-w-xs truncate font-semibold text-neutral-900 sm:max-w-md">
            {product.title}
          </span>
        </div>

        {/* Market & Language selector */}
        <div className="flex flex-wrap items-center gap-2">
          {markets && markets.length > 0 && (
            <div className="relative inline-flex items-center">
              <select
                aria-label="Thị trường"
                value={marketId ?? ""}
                onChange={(e) => handleMarketChange(e.target.value)}
                className="shadow-xs h-8 cursor-pointer appearance-none rounded-lg border border-neutral-200 bg-white pl-3 pr-8 text-xs font-medium text-neutral-700 outline-none hover:bg-neutral-50 focus:border-neutral-400"
              >
                {markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-neutral-400" />
            </div>
          )}

          {selectedMarket && (
            <div className="relative inline-flex items-center">
              <select
                aria-label="Quốc gia"
                value={countryCode ?? ""}
                onChange={(e) =>
                  handleCountryCodeChange(e.target.value || undefined)
                }
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
          )}

          <div className="relative inline-flex items-center">
            <select
              aria-label="Ngôn ngữ"
              value={locale}
              onChange={(e) =>
                handleLocaleChange(e.target.value as WeleticLocale)
              }
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

      {/* Main Section 1: Product Offer Details Hero Box (Shopee Affiliate style) */}
      <div className="shadow-xs space-y-6 rounded-2xl border border-neutral-200 bg-white p-6">
        <div>
          <h2 className="text-lg font-bold text-neutral-900">
            Product Offer Details
          </h2>
        </div>

        <div className="grid gap-6 md:grid-cols-12">
          {/* Left: Product Image */}
          <div className="md:col-span-4 lg:col-span-3">
            <div className="shadow-xs relative aspect-square w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
              {product.imageUrl ? (
                <BlurImage
                  src={product.imageUrl}
                  alt={product.title}
                  fill
                  className="object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">
                  No Image
                </div>
              )}
            </div>
          </div>

          {/* Right: Product Meta & Get Link Action */}
          <div className="flex flex-col justify-between space-y-4 md:col-span-8 lg:col-span-9">
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    {product.vendor || "Yamax"}
                  </span>
                  <span className="text-xs text-neutral-300">•</span>
                  <span className="text-xs font-medium text-neutral-500">
                    {product.productType || "Activewear"}
                  </span>
                </div>
                <h1 className="mt-1 text-base font-bold leading-snug text-neutral-900 sm:text-lg">
                  {product.title}
                </h1>
              </div>

              {/* Badges & Rating */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
                <div className="flex items-center gap-1 font-semibold text-amber-500">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  <span>5.0</span>
                </div>
                <span className="text-neutral-300">|</span>
                <span className="font-medium text-neutral-500">100+ Sold</span>
                <span className="text-neutral-300">|</span>
                <span className="inline-flex items-center gap-1 rounded-md border border-green-200/60 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                  Hoa hồng:{" "}
                  <strong className="font-bold">{commRatePercent}%</strong>
                </span>
                {product.customerDiscount && (
                  <>
                    <span className="text-neutral-300">|</span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-indigo-200/60 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                      Mã giảm cho khách:{" "}
                      <strong className="font-bold">
                        {product.customerDiscount.formatted}
                      </strong>
                    </span>
                  </>
                )}
              </div>

              {/* Price section */}
              <div className="flex flex-wrap items-baseline gap-2.5 pt-1">
                <span className="text-2xl font-extrabold tracking-tight text-neutral-900 sm:text-3xl">
                  {pricing.formattedPrice}
                </span>
                {pricing.hasDiscount && pricing.formattedCompareAtPrice && (
                  <span className="text-base text-neutral-400 line-through sm:text-lg">
                    {pricing.formattedCompareAtPrice}
                  </span>
                )}
                {pricing.hasDiscount && pricing.badgeText && (
                  <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                    {pricing.badgeText}
                  </span>
                )}
              </div>

              {/* Variants Selector */}
              {product.variants.length > 1 && (
                <div className="space-y-2 pt-1">
                  <label className="block text-xs font-medium text-neutral-600">
                    Phân loại / Biến thể:
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {product.variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setSelectedVariantId(v.id)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                          (selectedVariantId || product.variants[0].id) === v.id
                            ? "shadow-xs border-neutral-900 bg-neutral-900 text-white"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        {v.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Action Get Link */}
            <div className="flex flex-wrap items-center gap-3 pt-4">
              <Button
                text="Get Link"
                variant="primary"
                onClick={() => setShowLinkModal(true)}
                className="h-10 px-8 text-sm font-semibold"
              />
              <Button
                text="Tạo link tùy biến Sub_ID"
                variant="secondary"
                onClick={() => setShowLinkModal(true)}
                className="h-10 text-sm"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Section 2: Offer Details (Commission Breakdown Table matching Shopee) */}
      <div className="shadow-xs space-y-4 rounded-2xl border border-neutral-200 bg-white p-6">
        <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-neutral-700" />
            <h3 className="text-base font-bold text-neutral-900">
              Offer Details
            </h3>
          </div>
          <span className="rounded-md border border-green-200/50 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
            Commission Active
          </span>
        </div>

        {/* Commission Table */}
        <div className="overflow-x-auto rounded-xl border border-neutral-200">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 font-semibold text-neutral-500">
              <tr>
                <th className="px-4 py-3">Channel Type</th>
                <th className="px-4 py-3">Store Commission</th>
                <th className="px-4 py-3">Bonus Commission</th>
                <th className="px-4 py-3 text-right">Est. Commission Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 font-medium text-neutral-800">
              {/* Row 1: Live */}
              <tr className="transition hover:bg-neutral-50/50">
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-2 font-semibold text-neutral-900">
                    <span>Livestream / Store Live</span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">
                      Most Used Channel
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <span>
                    {commRatePercent}% ({formattedBaseCommission})
                  </span>
                </td>
                <td className="px-4 py-3.5 text-neutral-400">
                  <span>0% (₫0)</span>
                </td>
                <td className="px-4 py-3.5 text-right font-bold text-green-700">
                  {formattedBaseCommission}
                </td>
              </tr>

              {/* Row 2: Social Media */}
              <tr className="transition hover:bg-neutral-50/50">
                <td className="px-4 py-3.5">
                  <div className="font-semibold text-neutral-900">
                    Social Medias (TikTok, Facebook, Instagram, YouTube)
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <span>
                    {commRatePercent}% ({formattedBaseCommission})
                  </span>
                </td>
                <td className="px-4 py-3.5 text-green-600">
                  <span>+2% ({formattedSocialBonus})</span>
                </td>
                <td className="px-4 py-3.5 text-right font-bold text-green-700">
                  {formattedTotalSocialCommission}
                </td>
              </tr>

              {/* Row 3: Video & Bio */}
              <tr className="transition hover:bg-neutral-50/50">
                <td className="px-4 py-3.5">
                  <div className="font-semibold text-neutral-900">
                    Short Videos & Creator Bio Links
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <span>
                    {commRatePercent}% ({formattedBaseCommission})
                  </span>
                </td>
                <td className="px-4 py-3.5 text-neutral-400">
                  <span>0% (₫0)</span>
                </td>
                <td className="px-4 py-3.5 text-right font-bold text-green-700">
                  {formattedBaseCommission}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Policy & Tracking Meta */}
        <div className="grid gap-3 pt-2 sm:grid-cols-3">
          <div className="space-y-1 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
              <ShieldCheck className="h-4 w-4 text-green-600" />
              <span>Nguồn chính sách</span>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              {commissionSource}
            </p>
          </div>

          <div className="space-y-1 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
              <Clock className="h-4 w-4 text-neutral-600" />
              <span>Thời hạn lưu Cookie</span>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              Lưu trữ 30 ngày ghi nhận chuyển đổi cho mọi đơn hàng phát sinh sau
              click.
            </p>
          </div>

          <div className="space-y-1 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
              <Globe className="h-4 w-4 text-blue-600" />
              <span>Đa thị trường & Đa tiền tệ</span>
            </div>
            <p className="text-xs leading-relaxed text-neutral-500">
              Tự động thanh toán đúng đồng tiền của thị trường đích (VND, USD,
              JPY, MXN).
            </p>
          </div>
        </div>
      </div>

      {/* Main Section 3: Product Description / Information */}
      {product.descriptionHtml && (
        <div className="shadow-xs space-y-4 rounded-2xl border border-neutral-200 bg-white p-6">
          <h3 className="border-b border-neutral-100 pb-3 text-base font-bold text-neutral-900">
            Mô tả sản phẩm
          </h3>
          <div
            className="prose prose-sm max-w-none leading-relaxed text-neutral-700"
            dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
          />
        </div>
      )}

      {/* Product Offer Link Modal with 5 Sub_IDs */}
      <ProductOfferLinkModal
        showModal={showLinkModal}
        setShowModal={setShowLinkModal}
        product={product}
        programId={effectiveProgramId!}
        marketId={marketId}
        countryCode={countryCode}
        locale={locale}
      />
    </div>
  );
}
