import { isCoreLaunch } from "../core-launch-policy";
import { reviewCouponDisclosure } from "./coupon-disclosure";
import { reviewIncentivePolicySnapshotSchema } from "./incentive-policy";

export type ReviewDisclosure = Record<"en" | "ja" | "vi", string[]>;

/** Plain text only. Callers must first verify the invitation-owned policy digest.
 * Never derive the promise from the current earning rule or active policy.
 */
export function reviewIncentiveDisclosure(
  input: unknown,
): ReviewDisclosure | null {
  if (input === null) return null; // Preserve the separately handled legacy path.
  const { award } = reviewIncentivePolicySnapshotSchema.parse(input);
  if (award.kind === "none")
    return {
      en: [
        "No points or coupon are offered for this invitation. All ratings are welcome.",
      ],
      ja: [
        "このご案内にはポイントやクーポンの特典はありません。どのような評価も歓迎します。",
      ],
      vi: [
        "Lời mời này không có thưởng điểm hoặc phiếu giảm giá. Mọi xếp hạng đều được chào đón.",
      ],
    };
  if (award.kind === "coupon") {
    return reviewCouponDisclosure(award);
  }
  const {
    basePoints: base,
    photoBonusPoints: photo,
    videoBonusPoints: video,
    maxPoints: cap,
  } = award;
  // Preserve existing media-bonus promises even when new core policies cannot
  // offer them. Only participation-only promises use the reduced launch copy.
  if (isCoreLaunch() && photo === "0" && video === "0") {
    const points = BigInt(base) > BigInt(cap) ? cap : base;
    return {
      en: [
        `Valid participation: ${points} points. At most one reward per order.`,
        "The reward is independent of rating or publication; critical and unpublished reviews remain eligible when valid.",
        "Points require an active loyalty account. Submitting a review does not enroll you automatically; an eligible award waits for enrollment.",
      ],
      ja: [
        `有効なレビュー投稿で${points}ポイント。1注文につき特典は最大1回です。`,
        "特典は評価や公開状況に左右されず、有効な批判的レビューや未公開レビューも対象です。",
        "ポイントには有効なロイヤルティアカウントが必要です。レビューの送信で自動登録はされません。対象となる特典は登録まで保留されます。",
      ],
      vi: [
        `Đánh giá hợp lệ nhận ${points} điểm. Tối đa một phần thưởng cho mỗi đơn hàng.`,
        "Phần thưởng không phụ thuộc xếp hạng hay việc đăng công khai; đánh giá phê bình hoặc chưa công khai vẫn đủ điều kiện nếu hợp lệ.",
        "Điểm thưởng yêu cầu tài khoản loyalty đang hoạt động. Gửi đánh giá không tự động đăng ký tài khoản; phần thưởng hợp lệ được giữ chờ đăng ký.",
      ],
    };
  }
  return {
    en: [
      `Valid participation: ${base} base points; photo bonus ${photo}; maximum total ${cap} points. Saved video bonus: ${video}, currently unavailable because video uploads are not supported.`,
      "Only the larger eligible media bonus applies, not both. Media must be accepted through this store's supported upload flow.",
      "At most one reward per order across product and store reviews. The saved promise is independent of rating or publication; critical and unpublished reviews remain eligible when valid.",
      "Points require an active loyalty account. Submitting a review does not enroll you automatically; an eligible award waits for enrollment.",
    ],
    ja: [
      `有効な投稿の基本ポイント：${base}。写真ボーナス：${photo}。合計上限：${cap}ポイント。保存された動画ボーナス：${video}。動画のアップロードは未対応のため、現在は獲得できません。`,
      "対象となるメディアボーナスのうち高い方のみ適用され、両方は加算されません。このストアで対応するアップロード手順で受け付けられたメディアが対象です。",
      "商品レビューとストアレビューを合わせて、1注文につき特典は最大1回です。保存された特典条件は評価や公開状況に左右されず、有効な批判的レビューや未公開レビューも対象です。",
      "ポイントには有効なロイヤルティアカウントが必要です。レビューの送信で自動登録はされません。対象となる特典は登録まで保留されます。",
    ],
    vi: [
      `Đánh giá hợp lệ: ${base} điểm cơ bản; thưởng ảnh ${photo}; tổng tối đa ${cap} điểm. Mức thưởng video đã lưu: ${video}, hiện chưa thể nhận vì chưa hỗ trợ tải video lên.`,
      "Chỉ áp dụng khoản thưởng nội dung đa phương tiện hợp lệ cao hơn, không cộng cả hai. Nội dung phải được tiếp nhận qua luồng tải lên mà cửa hàng hỗ trợ.",
      "Tối đa một phần thưởng cho mỗi đơn hàng, tính chung đánh giá sản phẩm và cửa hàng. Cam kết đã lưu không phụ thuộc xếp hạng hay việc đăng công khai; đánh giá phê bình hoặc chưa công khai vẫn đủ điều kiện nếu hợp lệ.",
      "Điểm thưởng yêu cầu tài khoản loyalty đang hoạt động. Gửi đánh giá không tự động đăng ký tài khoản; phần thưởng hợp lệ được giữ chờ đăng ký.",
    ],
  };
}
