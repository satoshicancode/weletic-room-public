"use client";

import { WeleticCatalogProduct } from "@/lib/swr/use-weletic-products";
import { WeleticLocale } from "@/lib/weletic/localization";
import {
  formatMoney,
  getCatalogPricing,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { BlurImage, Modal } from "@dub/ui";
import { Clock, Globe, ShieldCheck, Sparkles, Tag, X } from "lucide-react";
import { useState } from "react";

interface ProductDetailModalProps {
  showModal: boolean;
  setShowModal: (show: boolean) => void;
  product: WeleticCatalogProduct | null;
  onGetLink: (product: WeleticCatalogProduct) => void;
  locale: WeleticLocale;
}

export function ProductDetailModal({
  showModal,
  setShowModal,
  product,
  onGetLink,
  locale,
}: ProductDetailModalProps) {
  const [selectedVariantId, setSelectedVariantId] = useState<
    string | undefined
  >(product?.variants[0]?.id);

  if (!product) return null;

  const currentVariant =
    product.variants.find((v) => v.id === selectedVariantId) ||
    product.variants[0];

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

  const commRateText = product.commission
    ? product.commission.type === "percentage"
      ? `${((product.commission.basisPoints ?? 0) / 100).toFixed(1)}%`
      : product.commission.fixedAmount && product.commission.currency
        ? formatMoney(
            {
              amount: BigInt(product.commission.fixedAmount),
              currency: normalizeCurrency(product.commission.currency),
            },
            locale,
          )
        : "10.0%"
    : "10.0%";

  const estimatedEarning =
    product.commission?.type === "percentage" && currentVariant
      ? formatMoney(
          {
            amount:
              (BigInt(currentVariant.amount) *
                BigInt(product.commission.basisPoints ?? 1000)) /
              BigInt(10000),
            currency: normalizeCurrency(currentVariant.currency),
          },
          locale,
        )
      : commRateText;

  const commissionSource =
    (product.commission as any)?.source === "product"
      ? "Cấu hình hoa hồng riêng cho sản phẩm (Custom Product Rule)"
      : "Áp dụng chính sách mặc định của Nhóm (Default Group Rule)";

  return (
    <Modal
      showModal={showModal}
      setShowModal={setShowModal}
      className="max-w-2xl overflow-hidden rounded-2xl bg-white p-0 shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-800">
            Chi tiết Sản phẩm & Hoa hồng
          </span>
          <span className="text-xs text-neutral-400">
            ID: {product.id.split("/").pop()}
          </span>
        </div>
        <button
          onClick={() => setShowModal(false)}
          className="rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[80vh] space-y-6 overflow-y-auto px-6 py-6">
        <div className="grid gap-6 sm:grid-cols-2">
          {/* Product Image */}
          <div className="shadow-xs relative aspect-square overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
            {product.imageUrl ? (
              <BlurImage
                src={product.imageUrl}
                alt={product.title}
                className="h-full w-full object-cover object-center"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">
                Chưa có ảnh
              </div>
            )}
          </div>

          {/* Product Info & Highlights */}
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {product.vendor || "Yamax"}
              </p>
              <h2 className="mt-1 text-base font-semibold leading-snug text-neutral-900">
                {product.title}
              </h2>
            </div>

            {/* Price section */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <span className="block text-xs text-neutral-500">
                {pricing.hasDiscount ? "Giá ưu đãi:" : "Giá bán niêm yết:"}
              </span>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
                <span className="text-2xl font-bold text-neutral-900">
                  {pricing.formattedPrice}
                </span>
                {pricing.hasDiscount && pricing.formattedCompareAtPrice && (
                  <span className="text-sm text-neutral-400 line-through">
                    {pricing.formattedCompareAtPrice}
                  </span>
                )}
                {pricing.hasDiscount && pricing.badgeText && (
                  <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-600">
                    {pricing.badgeText}
                  </span>
                )}
              </div>
            </div>

            {/* Variant Selector */}
            {product.variants.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-neutral-700">
                  Chọn phân loại / Biến thể:
                </label>
                <div className="flex flex-wrap gap-2">
                  {product.variants.map((v) => (
                    <button
                      key={v.id}
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

            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  onGetLink(product);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-800"
              >
                <Sparkles className="h-4 w-4" />
                Lấy Link Tiếp Thị (Get Link)
              </button>
            </div>
          </div>
        </div>

        {/* Commission Detail Section */}
        <div className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50/70 p-5">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-neutral-700" />
            <h3 className="text-sm font-semibold text-neutral-900">
              Thông tin cấu hình Hoa hồng (Commission Structure)
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="shadow-xs rounded-lg border border-neutral-200/80 bg-white p-3">
              <span className="block text-[11px] text-neutral-500">
                Tỷ lệ hoa hồng
              </span>
              <span className="text-lg font-bold text-neutral-900">
                {commRateText}
              </span>
            </div>

            <div className="shadow-xs rounded-lg border border-neutral-200/80 bg-white p-3">
              <span className="block text-[11px] text-neutral-500">
                Thu nhập ước tính/đơn
              </span>
              <span className="text-lg font-bold text-green-700">
                {estimatedEarning}
              </span>
            </div>

            <div className="shadow-xs col-span-2 rounded-lg border border-neutral-200/80 bg-white p-3 sm:col-span-1">
              <span className="block text-[11px] text-neutral-500">
                Thời hạn lưu Cookie
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-sm font-semibold text-neutral-800">
                <Clock className="h-3.5 w-3.5 text-neutral-500" />
                30 Ngày
              </span>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-neutral-200/80 bg-white p-3 text-xs text-neutral-600">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <span>
                <strong>Nguồn quy tắc:</strong> {commissionSource}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-neutral-700" />
              <span>
                <strong>Hỗ trợ đa thị trường:</strong> Tự động quy đổi và thanh
                toán theo đúng đơn vị tiền tệ của từng thị trường đã thiết lập
                (VND, JPY, MXN, USD).
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
