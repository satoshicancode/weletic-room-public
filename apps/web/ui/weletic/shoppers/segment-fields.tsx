"use client";
import React from "react";
import type { ShopperSegment } from "../../../lib/weletic/shoppers/segment-query";
import type { ShopperLocale } from "./copy";

export const segmentCopy = {
  en: {
    title: "Shopper segment",
    any: "Any",
    loyalty: "Loyalty account",
    enrolled: "Any enrolled account",
    not_enrolled: "Not enrolled",
    active: "Active",
    suspended: "Suspended",
    closed: "Closed",
    vip: "VIP assignment",
    assigned: "Assigned to an existing tier",
    unassigned: "Account without a tier",
    minPoints: "Minimum settled points",
    maxPoints: "Maximum settled points",
    purchase: "Recorded purchases",
    has_order: "Has an eligible order",
    no_order: "No eligible order recorded",
    purchasedFrom: "Order date from (UTC, inclusive)",
    purchasedBefore: "Order date before (UTC, exclusive)",
    note: "Conditions match together using current local records. Eligible orders are paid or partially refunded; missing local history does not prove a shopper never purchased. Points use the cached settled balance, excluding pending points. Tier filters require an account; assigned tiers exclude deleted tiers. This view does not enroll shoppers, create Partner groups, or authorize email.",
    invalid:
      "Check the segment: use whole-point values, an ordered date/points range, and compatible account/purchase conditions.",
    reset: "Clear segment",
  },
  ja: {
    title: "顧客セグメント",
    any: "指定なし",
    loyalty: "ロイヤルティアカウント",
    enrolled: "登録済みの全アカウント",
    not_enrolled: "未登録",
    active: "有効",
    suspended: "一時停止",
    closed: "閉鎖",
    vip: "VIPランク割り当て",
    assigned: "既存ランクに割り当て済み",
    unassigned: "ランク未設定のアカウント",
    minPoints: "確定ポイント下限",
    maxPoints: "確定ポイント上限",
    purchase: "記録済みの購入",
    has_order: "対象注文あり",
    no_order: "対象注文の記録なし",
    purchasedFrom: "注文開始日（UTC・含む）",
    purchasedBefore: "注文終了日（UTC・含まない）",
    note: "現在のローカル記録ですべての条件に一致する顧客を表示します。支払済み・一部返金の注文が対象です。履歴がないことは未購入の証明ではありません。ポイントは保留分を除くキャッシュ済み確定残高です。ランク条件はアカウントが必要で、削除済みランクは割り当て済みに含めません。会員登録、Partnerグループ作成、メール送信の許可は行いません。",
    invalid:
      "整数のポイント、日付・ポイントの範囲、アカウント・購入条件の組み合わせを確認してください。",
    reset: "条件をクリア",
  },
  vi: {
    title: "Phân khúc khách hàng",
    any: "Bất kỳ",
    loyalty: "Tài khoản loyalty",
    enrolled: "Mọi tài khoản đã tham gia",
    not_enrolled: "Chưa tham gia",
    active: "Đang hoạt động",
    suspended: "Tạm ngưng",
    closed: "Đã đóng",
    vip: "Hạng VIP được gán",
    assigned: "Có hạng hiện hữu",
    unassigned: "Tài khoản chưa có hạng",
    minPoints: "Điểm đã chốt tối thiểu",
    maxPoints: "Điểm đã chốt tối đa",
    purchase: "Lịch sử mua đã ghi nhận",
    has_order: "Có đơn đủ điều kiện",
    no_order: "Chưa ghi nhận đơn đủ điều kiện",
    purchasedFrom: "Ngày đặt từ (UTC, bao gồm)",
    purchasedBefore: "Ngày đặt trước (UTC, không bao gồm)",
    note: "Kết hợp tất cả điều kiện theo dữ liệu nội bộ hiện tại. Đơn đã thanh toán hoặc hoàn một phần được tính; thiếu lịch sử không chứng minh khách chưa từng mua. Điểm dùng số dư đã chốt được lưu đệm, không gồm điểm chờ. Lọc hạng yêu cầu có tài khoản; hạng đã xóa không được tính là đã gán. Không đăng ký loyalty, tạo nhóm Partner hoặc cấp quyền gửi email.",
    invalid:
      "Kiểm tra điểm nguyên, thứ tự khoảng ngày/điểm và các điều kiện tài khoản/mua hàng tương thích.",
    reset: "Xóa điều kiện",
  },
};

export function SegmentFields({
  value,
  onChange,
  locale,
  invalid,
  reset,
}: {
  value: ShopperSegment;
  onChange: (value: ShopperSegment) => void;
  locale: ShopperLocale;
  invalid: boolean;
  reset: () => void;
}) {
  const text = segmentCopy[locale];
  const descriptionId = React.useId();
  const control =
    "min-w-0 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm";
  const select = <K extends "loyalty" | "vip" | "purchase">(
    field: K,
    options: readonly ShopperSegment[K][],
  ) => (
    <label className="flex min-w-0 flex-col gap-1 text-sm" key={field}>
      {text[field]}
      <select
        className={control}
        name={field}
        value={value[field]}
        onChange={(event) =>
          onChange({ ...value, [field]: event.target.value })
        }
      >
        {options.map((option) => (
          <option value={option} key={option}>
            {text[option]}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset
      aria-describedby={descriptionId}
      className="w-full space-y-4 rounded-lg border border-neutral-200 p-4"
    >
      <legend className="px-1 font-medium">{text.title}</legend>
      <p id={descriptionId} className="text-sm text-neutral-600">
        {text.note}
      </p>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {select("loyalty", [
          "any",
          "enrolled",
          "not_enrolled",
          "active",
          "suspended",
          "closed",
        ])}
        {select("vip", ["any", "assigned", "unassigned"])}
        {select("purchase", ["any", "has_order", "no_order"])}
        {(
          [
            "minPoints",
            "maxPoints",
            "purchasedFrom",
            "purchasedBefore",
          ] as const
        ).map((field) => (
          <label key={field} className="flex min-w-0 flex-col gap-1 text-sm">
            {text[field]}
            <input
              className={control}
              name={field}
              type={field.startsWith("purchased") ? "date" : "text"}
              maxLength={field.startsWith("purchased") ? 10 : 20}
              value={value[field]}
              onChange={(event) =>
                onChange({ ...value, [field]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-red-700">
          {text.invalid}
        </p>
      )}
      <button type="button" className={control} onClick={reset}>
        {text.reset}
      </button>
    </fieldset>
  );
}
