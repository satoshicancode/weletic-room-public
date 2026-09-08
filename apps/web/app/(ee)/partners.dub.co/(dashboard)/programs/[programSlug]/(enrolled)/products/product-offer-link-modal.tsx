"use client";

import { WeleticCatalogProduct } from "@/lib/swr/use-weletic-products";
import { WeleticLocale, getWeleticMessage } from "@/lib/weletic/localization";
import { getCatalogPricing } from "@/lib/weletic/money";
import { BlurImage, Button, Modal } from "@dub/ui";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface ProductOfferLinkModalProps {
  showModal: boolean;
  setShowModal: (show: boolean) => void;
  product: WeleticCatalogProduct | null;
  programId: string;
  marketId?: string;
  countryCode?: string;
  locale: WeleticLocale;
}

export function ProductOfferLinkModal({
  showModal,
  setShowModal,
  product,
  programId,
  marketId,
  countryCode,
  locale,
}: ProductOfferLinkModalProps) {
  const [subIdMode, setSubIdMode] = useState<"standard" | "advanced">(
    "standard",
  );
  const [subId1, setSubId1] = useState("");
  const [subId2, setSubId2] = useState("");
  const [subId3, setSubId3] = useState("");
  const [subId4, setSubId4] = useState("");
  const [subId5, setSubId5] = useState("");
  const [shortLink, setShortLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState(false);

  const defaultVariant = product?.variants[0];
  const pricing = useMemo(
    () =>
      defaultVariant
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
          },
    [defaultVariant, locale],
  );

  const promoMessage = useMemo(() => {
    if (!product || !shortLink) return "";

    const lines: string[] = [];

    // Title
    lines.push(`🔥 ${product.title}`);

    // Price & Discounts
    if (pricing.hasDiscount && pricing.formattedCompareAtPrice) {
      lines.push(
        locale === "vi"
          ? `💰 Giá ưu đãi: ${pricing.formattedPrice} (Giá gốc: ${pricing.formattedCompareAtPrice}${pricing.badgeText ? ` - ${pricing.badgeText}` : ""})`
          : locale === "ja"
            ? `💰 特別価格: ${pricing.formattedPrice} (参考価格: ${pricing.formattedCompareAtPrice}${pricing.badgeText ? ` - ${pricing.badgeText}` : ""})`
            : `💰 Special Price: ${pricing.formattedPrice} (Was: ${pricing.formattedCompareAtPrice}${pricing.badgeText ? ` - ${pricing.badgeText}` : ""})`,
      );
    } else {
      lines.push(
        locale === "vi"
          ? `💰 Giá: ${pricing.formattedPrice}`
          : locale === "ja"
            ? `💰 価格: ${pricing.formattedPrice}`
            : `💰 Price: ${pricing.formattedPrice}`,
      );
    }

    // Customer Discount Voucher
    if (product.customerDiscount) {
      if (product.customerDiscount.couponCode) {
        lines.push(
          locale === "vi"
            ? `🎁 Nhập mã [${product.customerDiscount.couponCode}] để được giảm thêm ${product.customerDiscount.formatted}!`
            : locale === "ja"
              ? `🎁 クーポンコード【${product.customerDiscount.couponCode}】でさらに${product.customerDiscount.formatted}オフ！`
              : `🎁 Use code [${product.customerDiscount.couponCode}] for an extra ${product.customerDiscount.formatted} off!`,
        );
      } else {
        lines.push(
          locale === "vi"
            ? `🎁 Ưu đãi độc quyền: Giảm thêm ${product.customerDiscount.formatted}!`
            : locale === "ja"
              ? `🎁 限定特典: さらに${product.customerDiscount.formatted}オフ！`
              : `🎁 Exclusive Offer: Extra ${product.customerDiscount.formatted} off!`,
        );
      }
    }

    // CTA & Link
    lines.push(
      locale === "vi"
        ? `👉 Mua ngay tại: ${shortLink}`
        : locale === "ja"
          ? `👉 ご購入はこちら: ${shortLink}`
          : `👉 Get yours here: ${shortLink}`,
    );

    return lines.join("\n");
  }, [product, shortLink, pricing, locale]);

  const fetchLink = useCallback(
    async (customSubs?: {
      subId1?: string;
      subId2?: string;
      subId3?: string;
      subId4?: string;
      subId5?: string;
    }) => {
      if (!product) return;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/partner-profile/programs/${programId}/products/${product.id}/links`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              variantId: product.variants[0]?.id,
              marketId,
              countryCode,
              locale,
              subId1: customSubs?.subId1 ?? (subId1.trim() || undefined),
              subId2: customSubs?.subId2 ?? (subId2.trim() || undefined),
              subId3: customSubs?.subId3 ?? (subId3.trim() || undefined),
              subId4: customSubs?.subId4 ?? (subId4.trim() || undefined),
              subId5: customSubs?.subId5 ?? (subId5.trim() || undefined),
            }),
          },
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(
            result.error?.message ?? result.message ?? "Lỗi tạo link",
          );
        }
        setShortLink(result.shortLink);
      } catch (err: any) {
        toast.error(err.message || "Không thể tạo link affiliate");
      } finally {
        setLoading(false);
      }
    },
    [
      product,
      programId,
      marketId,
      countryCode,
      locale,
      subId1,
      subId2,
      subId3,
      subId4,
      subId5,
    ],
  );

  useEffect(() => {
    if (showModal && product) {
      setSubIdMode("standard");
      setSubId1("");
      setSubId2("");
      setSubId3("");
      setSubId4("");
      setSubId5("");
      setCopiedLink(false);
      setCopiedMessage(false);
      fetchLink({ subId1: "", subId2: "", subId3: "", subId4: "", subId5: "" });
    }
  }, [
    showModal,
    product?.id,
    marketId,
    countryCode,
    locale,
    product,
    fetchLink,
  ]);

  const handleCopyLink = async () => {
    if (!shortLink) return;
    try {
      await navigator.clipboard.writeText(shortLink);
      setCopiedLink(true);
      toast.success(
        locale === "vi"
          ? "Đã sao chép liên kết!"
          : locale === "ja"
            ? "リンクをコピーしました"
            : getWeleticMessage(locale, "catalog.linkCopied"),
      );
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      toast.success(`Đã sao chép link: ${shortLink}`);
    }
  };

  const handleCopyMessage = async () => {
    if (!promoMessage) return;
    try {
      await navigator.clipboard.writeText(promoMessage);
      setCopiedMessage(true);
      toast.success(
        locale === "vi"
          ? "Đã sao chép thông điệp quảng bá!"
          : locale === "ja"
            ? "メッセージをコピーしました"
            : "Promo message copied to clipboard!",
      );
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch {
      toast.success("Đã sao chép thông điệp!");
    }
  };

  const handleAddParams = () => {
    fetchLink();
    toast.success("Đã cập nhật Sub_Id vào đường link!");
  };

  if (!showModal || !product) return null;

  return (
    <Modal
      showModal={showModal}
      setShowModal={setShowModal}
      className="max-w-lg overflow-hidden rounded-2xl bg-white p-0 shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
        <h3 className="text-base font-semibold text-neutral-900">
          Product Offer Link
        </h3>
        <button
          onClick={() => setShowModal(false)}
          className="rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 px-6 py-5">
        {/* Product Preview Header */}
        <div className="flex items-center gap-3.5 rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
          <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {product.imageUrl ? (
              <BlurImage
                src={product.imageUrl}
                alt={product.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">
                No image
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <h4 className="truncate text-xs font-semibold text-neutral-900">
              {product.title}
            </h4>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold text-neutral-900">
                {pricing.formattedPrice}
              </span>
              {pricing.hasDiscount && pricing.formattedCompareAtPrice && (
                <span className="text-[11px] text-neutral-400 line-through">
                  {pricing.formattedCompareAtPrice}
                </span>
              )}
              {pricing.hasDiscount && pricing.badgeText && (
                <span className="rounded border border-rose-200/60 bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-600">
                  {pricing.badgeText}
                </span>
              )}
              {product.customerDiscount && (
                <span className="rounded border border-indigo-200/60 bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold text-indigo-600">
                  Mã giảm: {product.customerDiscount.formatted}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Radio Mode Selector */}
        <div className="flex items-center gap-6 text-sm">
          <span className="font-medium text-neutral-700">Sub_id</span>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-neutral-800">
            <input
              type="radio"
              name="subIdMode"
              checked={subIdMode === "standard"}
              onChange={() => setSubIdMode("standard")}
              className="h-4 w-4 accent-neutral-900"
            />
            <span>Standard</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-neutral-800">
            <input
              type="radio"
              name="subIdMode"
              checked={subIdMode === "advanced"}
              onChange={() => setSubIdMode("advanced")}
              className="h-4 w-4 accent-neutral-900"
            />
            <span>Advanced</span>
          </label>
        </div>

        {/* Advanced Sub_ID Inputs */}
        {subIdMode === "advanced" && (
          <div className="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">
                Sub_id1
              </label>
              <input
                value={subId1}
                onChange={(e) => setSubId1(e.target.value)}
                placeholder="Example: SportShoes"
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">
                Sub_id2
              </label>
              <input
                value={subId2}
                onChange={(e) => setSubId2(e.target.value)}
                placeholder="Example: InstagramFeed"
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">
                Sub_id3
              </label>
              <input
                value={subId3}
                onChange={(e) => setSubId3(e.target.value)}
                placeholder="Example: 1212BirthdaySale"
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">
                Sub_id4
              </label>
              <input
                value={subId4}
                onChange={(e) => setSubId4(e.target.value)}
                placeholder=""
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">
                Sub_id5
              </label>
              <input
                value={subId5}
                onChange={(e) => setSubId5(e.target.value)}
                placeholder=""
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-500"
              />
            </div>

            <p className="pt-1 text-[11px] leading-relaxed text-neutral-500">
              <strong className="font-semibold text-neutral-700">Notes:</strong>{" "}
              You can add more parameter to track your link performance by
              Sub_Id(s) tagging. Click &quot;Add to Link&quot; to append the
              parameter to your link. Alphanumeric value only (a-z, A-Z, 0-9).
            </p>

            <div className="flex justify-end pt-1">
              <Button
                text={loading ? "Adding..." : "Add to Link"}
                variant="secondary"
                disabled={loading}
                onClick={handleAddParams}
                className="h-8 px-3 text-xs"
              />
            </div>
          </div>
        )}

        {/* Message Output Box */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">
            Message
          </label>
          <textarea
            readOnly
            rows={4}
            value={
              loading
                ? locale === "vi"
                  ? "Đang tạo liên kết tiếp thị..."
                  : locale === "ja"
                    ? "リンクを生成中..."
                    : "Generating short link..."
                : promoMessage
            }
            className="w-full select-all resize-none rounded-lg border border-neutral-200 bg-neutral-50 p-3 font-sans text-xs leading-relaxed text-neutral-800 outline-none focus:border-neutral-400"
          />
        </div>

        {/* Action Buttons: Copy Link (Left) & Copy Message (Right) */}
        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button
            text={
              copiedLink
                ? locale === "vi"
                  ? "Đã sao chép!"
                  : locale === "ja"
                    ? "コピー完了!"
                    : "Copied!"
                : locale === "vi"
                  ? "Copy Link"
                  : locale === "ja"
                    ? "リンクをコピー"
                    : "Copy Link"
            }
            variant="secondary"
            disabled={loading || !shortLink}
            onClick={handleCopyLink}
            className="h-10 text-xs font-medium sm:text-sm"
          />
          <Button
            text={
              copiedMessage
                ? locale === "vi"
                  ? "Đã sao chép!"
                  : locale === "ja"
                    ? "コピー完了!"
                    : "Copied!"
                : locale === "vi"
                  ? "Copy Message"
                  : locale === "ja"
                    ? "メッセージをコピー"
                    : "Copy Message"
            }
            variant="primary"
            disabled={loading || !shortLink}
            onClick={handleCopyMessage}
            className="h-10 text-xs font-semibold sm:text-sm"
          />
        </div>
      </div>
    </Modal>
  );
}
