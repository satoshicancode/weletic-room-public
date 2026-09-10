/**
 * Weletic Customer Loyalty & VIP Storefront Widget
 * Theme App Extension Asset for Shopify Storefronts
 * Strictly compliant with Zero-PII DOM architecture.
 */
(function () {
  "use strict";

  var RUNTIME_KEY = "WeleticLoyaltyWidgetRuntime";
  var CONTROLLER_KEY = "__weleticLoyaltyWidgetController";
  var ROOT_SELECTOR = "[data-weletic-loyalty-root], #weletic-loyalty-root";

  // Only interface copy is translated here. Merchant-authored names and branding
  // remain unchanged; no customer data or executable templates enter this map.
  var CORE_COPY = {
    "Your balance may be out of date. Refresh it before retrying a redemption.":
      [
        "残高が最新でない可能性があります。交換を再試行する前に残高を更新してください。",
        "Số dư có thể chưa được cập nhật. Hãy làm mới trước khi thử đổi thưởng lại.",
      ],
    Rewards: ["特典", "Phần thưởng"],
    "Rewards Club": ["会員特典", "Chương trình phần thưởng"],
    "Earn points, level up, and unlock rewards.": [
      "ポイントを貯めて、ランクアップと特典を楽しみましょう。",
      "Tích điểm, nâng hạng và nhận phần thưởng.",
    ],
    Close: ["閉じる", "Đóng"],
    Home: ["ホーム", "Trang chủ"],
    Earn: ["貯める", "Tích điểm"],
    Redeem: ["交換する", "Đổi thưởng"],
    Refer: ["紹介する", "Giới thiệu"],
    "Available Points": ["利用可能ポイント", "Điểm khả dụng"],
    " (+{points} pending)": ["（保留中：{points}）", " (+{points} đang chờ)"],
    "Loading your rewards...": ["特典を読み込み中…", "Đang tải phần thưởng…"],
    "Rewards are temporarily unavailable.": [
      "特典は一時的にご利用いただけません。",
      "Phần thưởng tạm thời không khả dụng.",
    ],
    "Try again": ["再試行", "Thử lại"],
    "Refresh balance": ["残高を更新", "Làm mới số dư"],
    "Confirm redemption": ["交換を確定", "Xác nhận đổi thưởng"],
    "{points} points will be spent.": [
      "{points}ポイントを使用します。",
      "Bạn sẽ sử dụng {points} điểm.",
    ],
    Cancel: ["キャンセル", "Hủy"],
    "Your session expired. Sign in again to view your balance and rewards.": [
      "セッションの有効期限が切れました。残高と特典を確認するには再度ログインしてください。",
      "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để xem số dư và phần thưởng.",
    ],
    "Your reward was issued, but the balance could not refresh. Refresh your balance before redeeming again.":
      [
        "特典は発行済みですが、残高を更新できませんでした。次の交換前に残高を更新してください。",
        "Phần thưởng đã được phát hành nhưng chưa thể cập nhật số dư. Hãy làm mới số dư trước khi đổi tiếp.",
      ],
    "We could not confirm this redemption. Check your wallet before retrying. Retrying the same reward and points uses the same request.":
      [
        "交換結果を確認できませんでした。再試行前に特典一覧をご確認ください。同じ特典とポイント数での再試行は同じリクエストを使用します。",
        "Chưa thể xác nhận kết quả đổi thưởng. Hãy kiểm tra ví trước khi thử lại. Thử lại cùng phần thưởng và số điểm sẽ dùng lại yêu cầu cũ.",
      ],
    "Your member balance is temporarily unavailable. Public program details remain available.":
      [
        "会員残高を一時的に取得できません。公開中のプログラム情報は引き続きご覧いただけます。",
        "Số dư thành viên tạm thời không khả dụng. Bạn vẫn có thể xem thông tin chương trình công khai.",
      ],
    "Your member balance is temporarily unavailable.": [
      "会員残高を一時的に取得できません。",
      "Số dư thành viên tạm thời không khả dụng.",
    ],
    "Program details are temporarily unavailable. Member rewards already issued to your account remain visible.":
      [
        "プログラム情報を一時的に取得できません。発行済みの会員特典は引き続き確認できます。",
        "Thông tin chương trình tạm thời không khả dụng. Bạn vẫn có thể xem phần thưởng đã được phát hành.",
      ],
    "We could not load your rewards. Please try again.": [
      "特典を読み込めませんでした。再試行してください。",
      "Không thể tải phần thưởng. Vui lòng thử lại.",
    ],
    "Rewards could not start. Please refresh this page.": [
      "特典を表示できません。このページを再読み込みしてください。",
      "Không thể khởi động phần thưởng. Vui lòng tải lại trang.",
    ],
    "Your loyalty account is currently unavailable for earning, redemption, and referrals. Existing wallet rewards and history remain visible.":
      [
        "現在、ポイント獲得・交換・紹介はご利用いただけません。発行済み特典と履歴は確認できます。",
        "Tài khoản hiện không thể tích điểm, đổi thưởng hoặc giới thiệu. Phần thưởng và lịch sử hiện có vẫn được hiển thị.",
      ],
    "This rewards program is currently unavailable.": [
      "この特典プログラムは現在ご利用いただけません。",
      "Chương trình phần thưởng hiện không khả dụng.",
    ],
    "Join the Rewards Club": [
      "特典プログラムに参加",
      "Tham gia chương trình phần thưởng",
    ],
    "Become a VIP Member": ["会員になる", "Trở thành thành viên VIP"],
    "Your signed-in account is not enrolled in rewards yet. Join the program before earning or redeeming points.":
      [
        "このアカウントは特典プログラムに未参加です。ポイントの獲得・交換には参加が必要です。",
        "Tài khoản của bạn chưa tham gia chương trình. Hãy tham gia trước khi tích điểm hoặc đổi thưởng.",
      ],
    "Join our rewards program to earn points on every purchase and unlock exclusive vouchers.":
      [
        "特典プログラムに参加して、お買い物でポイントを貯め、限定特典を獲得しましょう。",
        "Tham gia chương trình để tích điểm khi mua hàng và nhận ưu đãi dành riêng cho thành viên.",
      ],
    "Create Account & Earn Points": [
      "アカウントを作成",
      "Tạo tài khoản và tích điểm",
    ],
    "Sign In": ["ログイン", "Đăng nhập"],
    "Reward Redeemed!": ["特典を交換しました！", "Đổi thưởng thành công!"],
    "Store credit was added to your Shopify customer balance.": [
      "ストアクレジットをShopifyアカウントの残高に追加しました。",
      "Tín dụng cửa hàng đã được cộng vào số dư tài khoản Shopify của bạn.",
    ],
    "Use this gift card at checkout": [
      "お支払い時にこのギフトカードをご利用ください",
      "Sử dụng thẻ quà tặng này khi thanh toán",
    ],
    "Use this discount code at checkout": [
      "お支払い時にこの割引コードをご利用ください",
      "Sử dụng mã giảm giá này khi thanh toán",
    ],
    "Your Rewards": ["保有特典", "Phần thưởng của bạn"],
    "You have no available coupons.": [
      "利用可能なクーポンはありません。",
      "Bạn chưa có mã ưu đãi khả dụng.",
    ],
    Available: ["利用可能", "Khả dụng"],
    Used: ["使用済み", "Đã sử dụng"],
    Expired: ["期限切れ", "Đã hết hạn"],
    Cancelled: ["キャンセル済み", "Đã hủy"],
    "Gift card code": ["ギフトカードコード", "Mã thẻ quà tặng"],
    "Shopify store credit": [
      "Shopifyストアクレジット",
      "Tín dụng cửa hàng Shopify",
    ],
    "Discount code": ["割引コード", "Mã giảm giá"],
    "Added to your customer balance": [
      "アカウント残高に追加済み",
      "Đã cộng vào số dư tài khoản",
    ],
    "Available in your account": [
      "アカウントで確認できます",
      "Có trong tài khoản của bạn",
    ],
    "{points} points": ["{points}ポイント", "{points} điểm"],
    " · Expires {date}": ["・有効期限：{date}", " · Hết hạn {date}"],
    "Copy code": ["コードをコピー", "Sao chép mã"],
    "Copied!": ["コピーしました", "Đã sao chép!"],
    "Copy unavailable — select manually": [
      "コピーできません。手動で選択してください",
      "Không thể sao chép — hãy chọn thủ công",
    ],
    "Use reward": ["特典を使う", "Sử dụng phần thưởng"],
    "Reward History": ["特典履歴", "Lịch sử phần thưởng"],
    " · Order {order}": ["・注文：{order}", " · Đơn hàng {order}"],
    "Quick Rewards": ["おすすめの特典", "Đổi thưởng nhanh"],
    "From ": ["必要ポイント：", "Từ "],
    "Points to redeem": ["交換するポイント数", "Số điểm muốn đổi"],
    "Redeeming…": ["交換中…", "Đang đổi thưởng…"],
    "Account unavailable": ["アカウント利用不可", "Tài khoản không khả dụng"],
    "Balance unavailable": ["残高取得不可", "Số dư không khả dụng"],
    "Members only": ["会員限定", "Chỉ dành cho thành viên"],
    "Need more pts": ["ポイント不足", "Chưa đủ điểm"],
    "Need pts": ["ポイント不足", "Chưa đủ điểm"],
    "Redeem Points for Rewards": [
      "ポイントを特典に交換",
      "Đổi điểm lấy phần thưởng",
    ],
    "Ways to Earn Points": ["ポイントの貯め方", "Cách tích điểm"],
    "VIP Tier Benefits": ["VIPランク特典", "Quyền lợi hạng VIP"],
    "Amount off": ["金額割引", "Giảm tiền"],
    "{amount} off": ["{amount}割引", "Giảm {amount}"],
    "Choose a valid points amount within the reward limits.": [
      "特典の範囲内で有効なポイント数を選択してください。",
      "Chọn số điểm hợp lệ trong giới hạn của phần thưởng.",
    ],
  };

  if (window[RUNTIME_KEY]) {
    window[RUNTIME_KEY].mountAll(document);
    return;
  }

  function initLoyaltyWidget(root) {
    if (!root) return null;
    var shared = window.WeleticLoyaltyShared;
    var requestedLocale = String(
      root.getAttribute("data-locale") || document.documentElement.lang || "en",
    )
      .toLowerCase()
      .split(/[-_]/)[0];
    var locale =
      requestedLocale === "ja" || requestedLocale === "vi"
        ? requestedLocale
        : "en";
    function translate(message, values) {
      var variants = CORE_COPY[message];
      var result =
        variants && locale !== "en"
          ? variants[locale === "ja" ? 0 : 1]
          : message;
      return result.replace(/\{(\w+)\}/g, function (match, key) {
        return values && Object.prototype.hasOwnProperty.call(values, key)
          ? String(values[key])
          : match;
      });
    }
    var destroyed = false;
    var abortController =
      typeof window.AbortController === "function"
        ? new window.AbortController()
        : null;
    var timeoutIds = [];

    function requestOptions(init) {
      var options = Object.assign({}, init || {});
      if (abortController) options.signal = abortController.signal;
      return options;
    }

    function scheduleTimeout(callback, delay) {
      var timeoutId = window.setTimeout(function () {
        timeoutIds = timeoutIds.filter(function (candidate) {
          return candidate !== timeoutId;
        });
        if (!destroyed) callback();
      }, delay);
      timeoutIds.push(timeoutId);
    }

    var shop = root.getAttribute("data-shop") || window.location.hostname;
    var isLoggedIn = root.getAttribute("data-logged-in") === "true";
    var currency = root.getAttribute("data-currency") || "USD";
    var loginUrl = root.getAttribute("data-login-url") || "/account/login";
    var registerUrl =
      root.getAttribute("data-register-url") || "/account/register";
    var position = root.getAttribute("data-position") || "bottom_right";
    var primaryColor = root.getAttribute("data-primary-color") || "#6366f1";
    var headerTextColor = "#ffffff";
    var launcherText =
      root.getAttribute("data-launcher-text") || translate("Rewards");
    var launcherIcon = "sparkles";
    var proxyPrefix = root.getAttribute("data-proxy-prefix") || "/apps/weletic";
    var referralStorageKey = "weletic_referral_code";
    var capturedReferralCode = null;
    try {
      var referralParams = new URLSearchParams(window.location.search);
      var referralCodeFromUrl = referralParams.get("ref");
      var referralCodeCandidate = referralCodeFromUrl;
      if (!referralCodeCandidate) {
        try {
          referralCodeCandidate =
            window.sessionStorage.getItem(referralStorageKey);
        } catch (_storageReadError) {
          referralCodeCandidate = null;
        }
      }
      if (typeof referralCodeCandidate === "string") {
        referralCodeCandidate = referralCodeCandidate.trim();
        if (
          referralCodeCandidate.length > 0 &&
          referralCodeCandidate.length <= 64
        ) {
          capturedReferralCode = referralCodeCandidate;
          if (referralCodeFromUrl) {
            try {
              window.sessionStorage.setItem(
                referralStorageKey,
                capturedReferralCode,
              );
            } catch (_storageWriteError) {
              // The URL referral remains valid when browser storage is blocked.
            }
          }
        }
      }
    } catch (_error) {
      capturedReferralCode = null;
    }

    function formatMinorMoney(amount, currencyCode) {
      return shared
        ? shared.formatMinorMoney(amount, currencyCode || currency, locale)
        : (currencyCode || currency) + " " + formatNumber(amount);
    }

    function formatTierRequirement(tier) {
      var milestoneMode = state.program?.program?.vipMilestoneMode;
      var pointsRequirement = shared
        ? shared.formatInteger(tier.minPointsThreshold || 0)
        : formatNumber(tier.minPointsThreshold || 0);
      var spendRequirement = formatMinorMoney(
        tier.minSpendThreshold || 0,
        state.program?.currency,
      );

      if (milestoneMode === "points_earned") {
        return "Points requirement: " + pointsRequirement;
      }
      if (milestoneMode === "both") {
        return "Spend: " + spendRequirement + " • Points: " + pointsRequirement;
      }
      return "Spend requirement: " + spendRequirement;
    }

    function formatRewardDate(value) {
      if (!value) return "";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
    }

    function rewardStatusLabel(status) {
      if (status === "available") return translate("Available");
      if (status === "used") return translate("Used");
      if (status === "expired") return translate("Expired");
      return translate("Cancelled");
    }

    function rewardArtifactKind(reward) {
      if (reward && reward.artifactKind) return reward.artifactKind;
      if (reward && reward.giftCardCode) return "gift_card";
      return "discount_code";
    }

    function rewardArtifactCode(reward) {
      if (rewardArtifactKind(reward) === "store_credit") return null;
      return (
        (reward && reward.artifactCode) ||
        (reward && reward.giftCardCode) ||
        (reward && reward.discountCode) ||
        null
      );
    }

    function rewardArtifactLabel(reward) {
      var kind = rewardArtifactKind(reward);
      if (kind === "gift_card") return translate("Gift card code");
      if (kind === "store_credit") return translate("Shopify store credit");
      return translate("Discount code");
    }

    function formatShopperRewardValue(reward) {
      if (
        reward.rewardType === "amount_off" &&
        reward.exchangeType !== "incremental"
      ) {
        return translate("{amount} off", {
          amount: formatMinorMoney(
            reward.discountValue,
            state.program?.currency || currency,
          ),
        });
      }
      return shared.formatRewardValue(
        reward,
        state.program?.currency || currency,
      );
    }

    function isOnlineStoreReward(reward) {
      return shared
        ? shared.isOnlineStoreReward(reward)
        : Boolean(reward) &&
            (reward.salesChannel === "online_store" ||
              reward.salesChannel === "both");
    }

    function canonicalPointInteger(value) {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
      }
      if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
        return null;
      }
      try {
        return BigInt(value.trim()).toString();
      } catch (_error) {
        return null;
      }
    }

    function rewardPointOptions(reward, availablePoints) {
      var incremental = reward.exchangeType === "incremental";
      var minimum = canonicalPointInteger(
        incremental
          ? reward.minPointsCost || reward.pointsCost
          : reward.pointsCost,
      );
      var step = canonicalPointInteger(
        incremental ? reward.pointsStep : reward.pointsCost,
      );
      var available = canonicalPointInteger(availablePoints);
      var configuredMaximum = canonicalPointInteger(
        reward.maxPointsCost || available,
      );
      var maximum =
        available && configuredMaximum
          ? shared.minIntegerValue(available, configuredMaximum)
          : null;
      return {
        incremental: incremental,
        minimum: minimum || "0",
        maximum: maximum,
        step: step || "0",
        canRedeem:
          Boolean(minimum) &&
          Boolean(available) &&
          shared.isIntegerAtLeast(available, minimum),
      };
    }

    function isValidPointSelection(value, minimum, maximum, step) {
      var selected = canonicalPointInteger(value);
      var min = canonicalPointInteger(minimum);
      var max = canonicalPointInteger(maximum);
      var increment = canonicalPointInteger(step);
      if (!selected || !min || !max || !increment) return false;
      var selectedValue = BigInt(selected);
      var minimumValue = BigInt(min);
      var maximumValue = BigInt(max);
      var stepValue = BigInt(increment);
      return (
        stepValue > BigInt(0) &&
        selectedValue >= minimumValue &&
        selectedValue <= maximumValue &&
        selectedValue % stepValue === BigInt(0)
      );
    }

    function isProgramActive(programData) {
      return programData?.program?.isActive === true;
    }

    function customerCanParticipate(customer, programIsActive) {
      return shared
        ? shared.customerCanParticipate(customer, programIsActive)
        : programIsActive === true &&
            customer?.account?.status === "active" &&
            customer.account.canParticipate === true;
    }

    function hasPositivePoints(value) {
      return Boolean(shared && shared.isIntegerAtLeast(value, "1"));
    }

    function activeReferralOffer(programData) {
      if (!isProgramActive(programData)) return null;
      var offer = programData?.referralOffer;
      if (!offer || offer.isActive !== true) return null;

      var validFriendReward =
        offer.friendRewardKind === "points"
          ? hasPositivePoints(offer.friendPointsReward)
          : offer.friendRewardKind === "coupon" &&
            offer.friendClaimEnabled === true &&
            Boolean(offer.friendRewardName);
      var validAdvocateReward =
        offer.advocateRewardKind === "points"
          ? hasPositivePoints(offer.advocatePointsReward)
          : offer.advocateRewardKind === "coupon" &&
            Boolean(offer.advocateRewardName);

      return validFriendReward && validAdvocateReward ? offer : null;
    }

    function referralBenefit(offer, audience, singular, plural) {
      var kind = offer?.[audience + "RewardKind"];
      if (kind === "coupon") {
        return offer[audience + "RewardName"];
      }
      return shared.formatPoints(
        offer?.[audience + "PointsReward"],
        singular,
        plural,
      );
    }

    function legacyCopyText(text) {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.setAttribute("aria-hidden", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      var copied = false;
      try {
        copied =
          typeof document.execCommand === "function" &&
          document.execCommand("copy") === true;
      } catch (_copyError) {
        copied = false;
      }
      document.body.removeChild(textarea);
      return copied;
    }

    function copyText(text) {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        return Promise.resolve()
          .then(function () {
            return navigator.clipboard.writeText(text);
          })
          .then(function () {
            return true;
          })
          .catch(function () {
            return legacyCopyText(text);
          });
      }
      return Promise.resolve(legacyCopyText(text));
    }

    function bindCopyButton(button, text, successLabel, idleLabel) {
      button.setAttribute("aria-live", "polite");
      button.addEventListener("click", function () {
        copyText(text).then(function (copied) {
          if (destroyed) return;
          button.textContent = copied
            ? successLabel
            : translate("Copy unavailable — select manually");
          if (copied) {
            scheduleTimeout(function () {
              button.textContent = idleLabel;
            }, 2000);
          }
        });
      });
    }

    // Set CSS variable
    document.documentElement.style.setProperty(
      "--weletic-primary",
      primaryColor,
    );

    // State
    var state = {
      isOpen: false,
      activeTab: "home",
      loading: false,
      mutationPending: false,
      error: null,
      programError: null,
      customerError: null,
      program: null,
      customer: null,
      lastRedeemedArtifact: null,
      friendClaim: null,
      activityMessage: null,
      confirmation: null,
      redemptionMessage: null,
      authenticationExpired: false,
    };
    var programRequest = null;
    var customerRequest = null;
    // A response started before a newer read or redemption cannot restore a
    // stale spendable balance. This is UI ordering, not a backend ledger fence.
    var customerSummaryEpoch = 0;
    var redemptionIntentKeys = {};
    var activityIntentKeys = {};
    var referralBindCodeInFlight = null;
    var nudge = null;
    var cartNudgeInvalidated = false;
    var cartNudgeVisible = false;
    function invalidateCartNudge(event) {
      if (
        event &&
        event.type === "click" &&
        nudge &&
        nudge.contains(event.target)
      )
        return;
      cartNudgeInvalidated = true;
      if (cartNudgeVisible) dismissNudge(false);
    }
    var cartNudgeEvents = [
      "click",
      "input",
      "change",
      "submit",
      "cart:updated",
      "visibilitychange",
    ];
    cartNudgeEvents.forEach(function (name) {
      document.addEventListener(name, invalidateCartNudge, true);
    });
    var firstVisit = Promise.resolve(false);
    try {
      if (shared && shared.claimLoyaltyFirstVisit) {
        firstVisit = shared.claimLoyaltyFirstVisit(
          window.localStorage,
          window.navigator.locks,
        );
      }
    } catch (_) {
      /* Optional prompts remain suppressed without storage. */
    }

    function dismissNudge(restoreFocus) {
      if (!nudge) return;
      var hadFocus = nudge.contains(document.activeElement);
      nudge.remove();
      nudge = null;
      cartNudgeVisible = false;
      if (restoreFocus && hadFocus && !launcherBtn.hidden) launcherBtn.focus();
    }

    async function showSignupNudge(program) {
      if (
        !shared ||
        !shared.selectLoyaltyNudge ||
        !shared.claimLoyaltyNudgeImpression
      )
        return;
      var isFirstVisit = await firstVisit;
      var policy =
        program && program.nudges && Array.isArray(program.nudges.policies)
          ? program.nudges.policies.find(function (item) {
              return item.kind === "signup";
            })
          : null;
      var template = policy && policy.templates && policy.templates[locale];
      if (
        !template ||
        [template.title, template.description, template.actionLabel].some(
          function (value) {
            return typeof value !== "string" || !value.trim();
          },
        )
      )
        return;
      function eligible() {
        return (
          !destroyed &&
          !state.isOpen &&
          !document.hidden &&
          state.program === program &&
          shared.selectLoyaltyNudge({
            stateFresh: !state.programError,
            programActive: isProgramActive(program),
            launcherVisible: !launcherBtn.hidden,
            authenticated:
              root.getAttribute("data-logged-in") === "true"
                ? true
                : root.getAttribute("data-logged-in") === "false"
                  ? false
                  : undefined,
            firstVisit: isFirstVisit,
            enabled: { signup: policy.enabled === true },
          }) === "signup"
        );
      }
      if (!eligible()) return;
      try {
        if (
          !(await shared.claimLoyaltyNudgeImpression({
            kind: "signup",
            nowMs: Date.now(),
            storage: window.localStorage,
            locks: window.navigator.locks,
            isEligible: eligible,
          })) ||
          !eligible()
        )
          return;
      } catch (_) {
        return;
      }
      renderNudge(policy, template);
    }

    function renderNudge(policy, template) {
      dismissNudge(false);
      nudge = document.createElement("aside");
      nudge.className =
        "weletic-nudge " +
        (position === "bottom_left" ? "weletic-pos-left" : "weletic-pos-right");
      nudge.lang = locale;
      nudge.setAttribute("aria-label", template.title);
      var icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = launcherIconGlyph(policy.icon);
      var title = document.createElement("h2");
      title.textContent = template.title;
      var description = document.createElement("p");
      description.textContent = template.description;
      var action = document.createElement("button");
      action.type = "button";
      action.textContent = template.actionLabel;
      action.addEventListener("click", function () {
        dismissNudge(false);
        if (policy.kind === "reward_usage") state.activeTab = "home";
        toggleDrawer(true);
      });
      var close = document.createElement("button");
      close.type = "button";
      close.textContent =
        locale === "ja" ? "閉じる" : locale === "vi" ? "Đóng" : "Dismiss";
      close.addEventListener("click", function () {
        dismissNudge(true);
      });
      nudge.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismissNudge(true);
        }
      });
      nudge.append(icon, title, description, action, close);
      document.body.appendChild(nudge);
    }

    // DOM Elements
    var launcherBtn = document.createElement("button");
    launcherBtn.className =
      "weletic-launcher-btn " +
      (position === "bottom_left" ? "weletic-pos-left" : "weletic-pos-right");
    launcherBtn.setAttribute("type", "button");
    launcherBtn.setAttribute("aria-label", launcherText);
    launcherBtn.innerHTML =
      '<span class="weletic-launcher-icon">' +
      launcherIconGlyph(launcherIcon) +
      '</span><span class="weletic-launcher-text">' +
      escapeHtml(launcherText) +
      "</span>";
    launcherBtn.hidden = true;

    var overlay = document.createElement("div");
    overlay.className = "weletic-modal-overlay";

    var drawer = document.createElement("div");
    drawer.className =
      "weletic-drawer " +
      (position === "bottom_left" ? "weletic-pos-left" : "weletic-pos-right");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("tabindex", "-1");
    drawer.hidden = true;

    document.body.appendChild(launcherBtn);
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    function launcherIconGlyph(icon) {
      if (icon === "award") return "🏅";
      if (icon === "gift") return "🎁";
      if (icon === "crown") return "👑";
      if (icon === "star") return "⭐";
      return "✨";
    }

    function applyProgramBranding(programData) {
      if (destroyed) return;
      var branding = programData?.branding || {};
      position =
        branding.launcherPosition === "bottom_left"
          ? "bottom_left"
          : branding.launcherPosition === "bottom_right"
            ? "bottom_right"
            : position;
      primaryColor = branding.primaryColor || primaryColor;
      headerTextColor = branding.headerTextColor || headerTextColor;
      launcherText = branding.launcherText || launcherText;
      launcherIcon = branding.launcherIcon || launcherIcon;

      document.documentElement.style.setProperty(
        "--weletic-primary",
        primaryColor,
      );
      document.documentElement.style.setProperty(
        "--weletic-header-text",
        headerTextColor,
      );
      launcherBtn.style.setProperty("--weletic-primary", primaryColor);
      drawer.style.setProperty("--weletic-primary", primaryColor);
      drawer.style.setProperty("--weletic-header-text", headerTextColor);
      launcherBtn.className =
        "weletic-launcher-btn " +
        (position === "bottom_left" ? "weletic-pos-left" : "weletic-pos-right");
      drawer.className =
        "weletic-drawer " +
        (position === "bottom_left"
          ? "weletic-pos-left"
          : "weletic-pos-right") +
        (state.isOpen ? " weletic-open" : "");
      launcherBtn.setAttribute("aria-label", launcherText);
      launcherBtn.innerHTML =
        '<span class="weletic-launcher-icon">' +
        launcherIconGlyph(launcherIcon) +
        '</span><span class="weletic-launcher-text">' +
        escapeHtml(launcherText) +
        "</span>";
      var showLauncher =
        (isProgramActive(programData) || isLoggedIn) &&
        branding.enableFloatingLauncher !== false;
      launcherBtn.hidden = !showLauncher;
      if (!showLauncher && state.isOpen) {
        toggleDrawer(false);
      }
    }

    function loadProgramMetadata() {
      if (!shared) {
        return Promise.reject(
          new Error(
            translate("Rewards could not start. Please refresh this page."),
          ),
        );
      }
      if (state.program) return Promise.resolve(state.program);
      if (!programRequest) {
        programRequest = shared
          .fetchJson(
            proxyPrefix + "/program?shop=" + encodeURIComponent(shop),
            requestOptions(),
          )
          .then(shared.normalizeProgram)
          .then(function (program) {
            state.program = program;
            state.programError = null;
            applyProgramBranding(program);
            return program;
          })
          .catch(function (error) {
            programRequest = null;
            throw error;
          });
      }
      return programRequest;
    }

    function loadCustomerSummary() {
      if (!isLoggedIn) return Promise.resolve(null);
      if (state.authenticationExpired) {
        return Promise.reject(
          new Error("Please sign in again to view rewards."),
        );
      }
      if (!shared) {
        return Promise.reject(
          new Error(
            translate("Rewards could not start. Please refresh this page."),
          ),
        );
      }
      if (state.customer && !state.customerError)
        return Promise.resolve(state.customer);
      if (!customerRequest) {
        customerRequest = shared
          .fetchJson(
            proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
            requestOptions(),
          )
          .then(shared.normalizeCustomer)
          .catch(function (error) {
            customerRequest = null;
            if (error?.status === 401 || error?.status === 403)
              expireAuthentication();
            throw error;
          });
      }
      return customerRequest;
    }

    // Events
    function handleLauncherClick() {
      toggleDrawer(true);
    }

    function handleOverlayClick() {
      toggleDrawer(false);
    }

    launcherBtn.addEventListener("click", handleLauncherClick);
    overlay.addEventListener("click", handleOverlayClick);
    document.addEventListener("keydown", handleDrawerKeydown);

    function drawerFocusables() {
      return Array.from(
        drawer.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
        ),
      ).filter(function (element) {
        return !element.hidden;
      });
    }

    function handleDrawerKeydown(event) {
      if (!state.isOpen || destroyed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (state.confirmation) {
          cancelRedemption();
        } else {
          toggleDrawer(false);
        }
      } else if (event.key === "Tab") {
        var elements = drawerFocusables();
        var first = elements[0] || drawer;
        var last = elements[elements.length - 1] || drawer;
        if (
          !drawer.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    }

    function toggleDrawer(open) {
      if (destroyed) return;
      if (open) dismissNudge(false);
      state.isOpen = open;
      drawer.hidden = !open;
      launcherBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        overlay.classList.add("weletic-open");
        drawer.classList.add("weletic-open");
        if (!state.program || (isLoggedIn && !state.customer)) {
          fetchProgramData();
        } else {
          render();
          bindCapturedReferral();
        }
      } else {
        state.confirmation = null;
        overlay.classList.remove("weletic-open");
        drawer.classList.remove("weletic-open");
        if (!launcherBtn.hidden) launcherBtn.focus();
      }
    }

    function cancelRedemption() {
      var rewardId = state.confirmation?.rewardId;
      state.confirmation = null;
      render();
      var origin = Array.from(drawer.querySelectorAll("[data-redeem-id]")).find(
        function (button) {
          return (
            button.getAttribute("data-redeem-id") === rewardId &&
            !button.disabled
          );
        },
      );
      if (origin) origin.focus();
    }

    function fetchProgramData() {
      state.loading = true;
      state.error = null;
      state.programError = null;
      render();

      if (!shared) {
        state.loading = false;
        state.error = translate(
          "Rewards could not start. Please refresh this page.",
        );
        render();
        return;
      }

      var programPromise = loadProgramMetadata();
      var summaryEpoch = ++customerSummaryEpoch;

      // Customer loyalty summary endpoint: /api/shopify/loyalty/customer (accessed via App Proxy /customer)
      var customerPromise = loadCustomerSummary();

      Promise.allSettled([programPromise, customerPromise])
        .then(function (results) {
          if (destroyed) return;
          var programResult = results[0];
          var customerResult = results[1];
          if (state.authenticationExpired) {
            expireAuthentication();
          } else if (
            summaryEpoch === customerSummaryEpoch &&
            customerResult.status === "fulfilled"
          ) {
            state.customer = customerResult.value;
            state.customerError = null;
          } else if (summaryEpoch === customerSummaryEpoch) {
            state.customer = null;
            state.customerError =
              programResult.status === "fulfilled"
                ? translate(
                    "Your member balance is temporarily unavailable. Public program details remain available.",
                  )
                : translate("Your member balance is temporarily unavailable.");
          }
          if (programResult.status === "fulfilled") {
            state.program = programResult.value;
            state.programError = null;
            applyProgramBranding(programResult.value);
          } else {
            console.warn(
              "[Weletic Loyalty Widget] Program fetch error:",
              programResult.reason,
            );
            state.program = null;
            state.programError = translate(
              "Program details are temporarily unavailable. Member rewards already issued to your account remain visible.",
            );
            launcherBtn.hidden = !isLoggedIn;
          }
          state.loading = false;
          state.error = null;
          render();
          bindCapturedReferral();
        })
        .catch(function (err) {
          if (destroyed) return;
          console.warn("[Weletic Loyalty Widget] Fetch error:", err);
          state.loading = false;
          state.error = translate(
            "We could not load your rewards. Please try again.",
          );
          render();
        });
    }

    var programPreload = loadProgramMetadata();
    programPreload.then(showMemberNudge).catch(function () {
      /* Optional cart hint only. */
    });
    programPreload.then(showSignupNudge).catch(function () {
      /* Optional prompt only. */
    });
    programPreload.catch(function (error) {
      if (destroyed) return;
      console.warn("[Weletic Loyalty Widget] Program preload failed:", error);
      state.programError = translate(
        "Program details are temporarily unavailable. Member rewards already issued to your account remain visible.",
      );
      launcherBtn.hidden = !isLoggedIn;
    });

    if (isLoggedIn && capturedReferralCode) {
      var preloadSummaryEpoch = ++customerSummaryEpoch;
      Promise.all([programPreload, loadCustomerSummary()])
        .then(function (results) {
          if (
            destroyed ||
            state.authenticationExpired ||
            preloadSummaryEpoch !== customerSummaryEpoch
          )
            return;
          state.program = results[0];
          state.customer = results[1];
          state.customerError = null;
          bindCapturedReferral();
          if (state.isOpen) render();
        })
        .catch(function () {
          // Keep the captured code for the normal drawer retry or next load.
        });
    }

    async function showMemberNudge(program) {
      if (
        !shared ||
        !shared.loyaltyCatalogNudgeEligible ||
        !shared.loyaltyWalletNudgeEligible ||
        !shared.loadLoyaltyNudgeCart ||
        root.getAttribute("data-page-type") !== "cart" ||
        root.getAttribute("data-logged-in") !== "true"
      )
        return;
      var policies =
        program && program.nudges && Array.isArray(program.nudges.policies)
          ? program.nudges.policies
          : [];
      var enabled = {};
      policies.forEach(function (item) {
        if (
          ["points_spending", "reward_usage"].includes(item.kind) &&
          item.enabled === true &&
          item.templates &&
          item.templates[locale]
        )
          enabled[item.kind] = true;
      });
      if (!enabled.points_spending && !enabled.reward_usage) return;
      var epoch = customerSummaryEpoch;
      var started = Date.now();
      var results = await Promise.all([
        loadCustomerSummary(),
        shared.loadLoyaltyNudgeCart(
          root.getAttribute("data-locale-root"),
          abortController && abortController.signal,
        ),
      ]);
      var customer = results[0];
      var cart = results[1];
      var collectionsByProduct = null;
      var scopedRewards =
        customer && Array.isArray(customer.rewards)
          ? customer.rewards.slice()
          : [];
      if (customer && Array.isArray(customer.rewardWallet))
        customer.rewardWallet.forEach(function (reward) {
          if (reward.termsSnapshot) scopedRewards.push(reward.termsSnapshot);
        });
      var needsMembership = scopedRewards.some(function (reward) {
        return (
          Array.isArray(reward.entitledCollectionIds) &&
          reward.entitledCollectionIds.length > 0
        );
      });
      if (
        cart &&
        needsMembership &&
        customerCanParticipate(customer, isProgramActive(program))
      ) {
        var productIds = Array.from(
          new Set(
            cart.lines.map(function (line) {
              return line.productId;
            }),
          ),
        );
        if (
          productIds.length <= 50 &&
          productIds.every(function (id) {
            return typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id);
          })
        ) {
          try {
            var membershipResult = await shared.fetchJson(
              proxyPrefix +
                "/customer/nudge-collections?productIds=" +
                encodeURIComponent(productIds.join(",")),
              requestOptions({ method: "GET", cache: "no-store" }),
            );
            var membership = membershipResult && membershipResult.membership;
            if (
              membership &&
              typeof membership === "object" &&
              !Array.isArray(membership)
            ) {
              var normalized = {};
              var valid = Object.keys(membership).length === productIds.length;
              productIds.forEach(function (id) {
                var values = membership["gid://shopify/Product/" + id];
                if (
                  !Array.isArray(values) ||
                  values.length > 20 ||
                  values.some(function (value) {
                    return (
                      typeof value !== "string" ||
                      !/^gid:\/\/shopify\/Collection\/[1-9][0-9]{0,19}$/.test(
                        value,
                      )
                    );
                  })
                )
                  valid = false;
                else normalized[id] = values;
              });
              if (valid) collectionsByProduct = normalized;
            }
          } catch (_) {
            /* Unknown membership suppresses collection-scoped hints. */
          }
        }
      }
      function selectedKind() {
        if (
          destroyed ||
          cartNudgeInvalidated ||
          state.isOpen ||
          state.authenticationExpired ||
          state.customerError ||
          state.programError ||
          state.program !== program ||
          customerSummaryEpoch !== epoch ||
          document.hidden ||
          Date.now() - started > 10000 ||
          Date.now() < started ||
          root.getAttribute("data-logged-in") !== "true" ||
          !customerCanParticipate(customer, isProgramActive(program)) ||
          !cart
        )
          return null;
        var rewards = Array.isArray(customer.rewards)
          ? customer.rewards.map(function (reward) {
              return Object.assign({}, reward, {
                eligible: shared.loyaltyCatalogNudgeEligible(
                  cart,
                  reward,
                  customer.program,
                  collectionsByProduct,
                ),
              });
            })
          : [];
        var wallet = Array.isArray(customer.rewardWallet)
          ? customer.rewardWallet.map(function (reward) {
              return Object.assign({}, reward, {
                exchangeType:
                  reward.termsSnapshot && reward.termsSnapshot.exchangeType,
                eligible: shared.loyaltyWalletNudgeEligible(
                  cart,
                  reward,
                  Date.now(),
                  collectionsByProduct,
                ),
              });
            })
          : [];
        return shared.selectLoyaltyNudge({
          stateFresh: true,
          programActive: true,
          launcherVisible: !launcherBtn.hidden,
          authenticated: true,
          cartPage: true,
          cartHasItems: cart.lines.length > 0,
          hasAppliedDiscount: cart.hasAppliedDiscount,
          nowMs: Date.now(),
          enabled: enabled,
          rewards: rewards,
          wallet: wallet,
          availablePoints: customer.account.pointsBalance,
        });
      }
      var kind = selectedKind();
      if (!kind) return;
      var policy = policies.find(function (item) {
        return item.kind === kind;
      });
      function eligible() {
        return selectedKind() === kind;
      }
      var source = policy.templates[locale];
      var template = {};
      ["title", "description", "actionLabel"].forEach(function (key) {
        template[key] =
          typeof source[key] === "string"
            ? source[key]
                .replace(/\{\{points_label\}\}/g, function () {
                  return customer.program.pointNamePlural || "Points";
                })
                .replace(/\{\{points_balance\}\}/g, function () {
                  return shared.formatInteger(
                    customer.account.pointsBalance,
                    locale,
                  );
                })
            : "";
      });
      if (
        !template.title.trim() ||
        !template.description.trim() ||
        !template.actionLabel.trim()
      )
        return;
      if (
        !(await shared.claimLoyaltyNudgeImpression({
          kind: kind,
          nowMs: Date.now(),
          storage: window.localStorage,
          locks: window.navigator.locks,
          isEligible: eligible,
        })) ||
        !eligible()
      )
        return;
      var visibleUntil = started + 10000;
      var finalNow = Date.now();
      if (kind === "reward_usage") {
        var qualifyingWallet = customer.rewardWallet.filter(function (reward) {
          return shared.loyaltyWalletNudgeEligible(
            cart,
            reward,
            finalNow,
            collectionsByProduct,
          );
        });
        if (!qualifyingWallet.length) return;
        qualifyingWallet.forEach(function (reward) {
          if (reward.expiresAt !== null) {
            visibleUntil = Math.min(visibleUntil, Date.parse(reward.expiresAt));
          }
        });
      }
      if (visibleUntil <= Date.now()) return;
      renderNudge(policy, template);
      cartNudgeVisible = true;
      var shownNudge = nudge;
      scheduleTimeout(
        function () {
          if (nudge === shownNudge) dismissNudge(true);
        },
        Math.max(0, visibleUntil - Date.now()),
      );
    }

    function clearCapturedReferral() {
      capturedReferralCode = null;
      try {
        window.sessionStorage.removeItem(referralStorageKey);
      } catch (_storageRemoveError) {
        // The in-memory code is still cleared when browser storage is blocked.
      }

      try {
        var currentUrl = new URL(window.location.href);
        if (currentUrl.searchParams.has("ref")) {
          currentUrl.searchParams.delete("ref");
          window.history.replaceState(
            window.history.state,
            "",
            currentUrl.pathname + currentUrl.search + currentUrl.hash,
          );
        }
      } catch (_urlCleanupError) {
        // URL cleanup is best-effort and does not affect the completed bind.
      }
    }

    function isTerminalReferralBindError(error) {
      var status = Number(error?.status);
      return (
        Number.isInteger(status) &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 425 &&
        status !== 429
      );
    }

    function bindCapturedReferral() {
      var referralCode = capturedReferralCode;
      if (
        !shared ||
        !isLoggedIn ||
        !referralCode ||
        referralBindCodeInFlight === referralCode ||
        !customerCanParticipate(state.customer, isProgramActive(state.program))
      ) {
        return;
      }

      referralBindCodeInFlight = referralCode;
      shared
        .fetchJson(
          proxyPrefix + "/customer/referral/bind",
          requestOptions({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ referralCode: referralCode }),
          }),
        )
        .then(function (result) {
          if (result?.success === true) {
            clearCapturedReferral();
            return;
          }
          referralBindCodeInFlight = null;
        })
        .catch(function (error) {
          if (isTerminalReferralBindError(error)) {
            clearCapturedReferral();
            return;
          }
          referralBindCodeInFlight = null;
        });
    }

    function redeemReward(rewardId, pointsRequested) {
      if (!isProgramActive(state.program)) return;
      if (!isLoggedIn) {
        window.location.href = loginUrl;
        return;
      }
      if (!customerCanParticipate(state.customer, true)) return;
      if (
        state.mutationPending ||
        state.customerError ||
        state.authenticationExpired
      )
        return;

      state.mutationPending = true;
      customerSummaryEpoch++;
      customerRequest = null;
      state.redemptionMessage = null;
      render();

      var intentId =
        rewardId +
        ":" +
        (pointsRequested !== undefined ? String(pointsRequested) : "fixed");
      var idempotencyKey = redemptionIntentKeys[intentId];
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        redemptionIntentKeys[intentId] = idempotencyKey;
      }
      var redemptionPayload = {
        shop: shop,
        rewardDefinitionId: rewardId,
        idempotencyKey: idempotencyKey,
      };
      if (pointsRequested !== undefined) {
        redemptionPayload.pointsRequested = pointsRequested;
      }

      shared
        .fetchJson(
          proxyPrefix + "/customer/redeem",
          requestOptions({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(redemptionPayload),
          }),
        )
        .then(function (data) {
          if (destroyed || state.authenticationExpired) return;
          if (data && data.success) {
            delete redemptionIntentKeys[intentId];
            state.lastRedeemedArtifact = {
              artifactKind: rewardArtifactKind(data),
              artifactCode: rewardArtifactCode(data),
            };
            state.activeTab = "home";
            // Refetch customer balance
            var refreshEpoch = ++customerSummaryEpoch;
            return shared
              .fetchJson(
                proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
                requestOptions(),
              )
              .then(shared.normalizeCustomer)
              .then(function (customer) {
                if (
                  destroyed ||
                  state.authenticationExpired ||
                  refreshEpoch !== customerSummaryEpoch
                )
                  return;
                if (!customer) {
                  throw new Error("Unable to refresh rewards summary");
                }
                state.customer = customer;
                state.customerError = null;
                customerRequest = null;
              })
              .catch(function (err) {
                if (destroyed || state.authenticationExpired) return;
                if (err?.status === 401 || err?.status === 403) {
                  expireAuthentication();
                  return;
                }
                if (refreshEpoch !== customerSummaryEpoch) return;
                customerRequest = null;
                state.customerError = translate(
                  "Your reward was issued, but the balance could not refresh. Refresh your balance before redeeming again.",
                );
                // Redemption already succeeded. Keep the issued code visible
                // even if refreshing the balance temporarily fails.
                console.warn(
                  "[Weletic Loyalty Widget] Summary refresh failed:",
                  err,
                );
              });
          } else {
            throw new Error(
              "Unable to redeem reward. Please check your points balance.",
            );
          }
        })
        .catch(function (error) {
          if (destroyed || state.authenticationExpired) return;
          if (error?.status === 401 || error?.status === 403) {
            expireAuthentication();
          } else {
            // Keep this intent's key after an unknown outcome. Never auto-resend
            // or substitute a fresh key for a manual retry of the same selection.
            state.redemptionMessage = translate(
              "We could not confirm this redemption. Check your wallet before retrying. Retrying the same reward and points uses the same request.",
            );
            customerRequest = null;
            customerSummaryEpoch++;
            state.customerError = translate(
              "Your balance may be out of date. Refresh it before retrying a redemption.",
            );
          }
        })
        .finally(function () {
          if (destroyed) return;
          state.mutationPending = false;
          render();
        });
    }

    function expireAuthentication() {
      customerSummaryEpoch++;
      state.authenticationExpired = true;
      state.customer = null;
      customerRequest = null;
      state.lastRedeemedArtifact = null;
      state.friendClaim = null;
      state.confirmation = null;
      state.redemptionMessage = null;
      state.activityMessage = null;
      state.customerError = translate(
        "Your session expired. Sign in again to view your balance and rewards.",
      );
    }

    function claimFriendReward(email) {
      var offer = activeReferralOffer(state.program);
      if (
        !capturedReferralCode ||
        !email ||
        !offer ||
        offer.friendRewardKind !== "coupon" ||
        offer.friendClaimEnabled !== true
      ) {
        return;
      }
      state.friendClaim = { status: "loading" };
      render();

      fetch(
        proxyPrefix + "/referral/claim",
        requestOptions({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referralCode: capturedReferralCode,
            email: email,
          }),
        }),
      )
        .then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok) {
              throw new Error(
                payload?.error?.message || "Unable to claim this reward.",
              );
            }
            return payload?.data || payload;
          });
        })
        .then(function (claim) {
          if (destroyed) return;
          state.friendClaim = claim;
        })
        .catch(function (error) {
          if (destroyed) return;
          state.friendClaim = {
            status: "error",
            message: error.message || "Unable to claim this reward.",
          };
        })
        .finally(function () {
          render();
        });
    }

    function claimCustomerActivity(rule) {
      if (state.authenticationExpired || state.customerError) return;
      if (!isProgramActive(state.program)) return;
      if (!isLoggedIn) {
        window.location.href = loginUrl;
        return;
      }
      if (!customerCanParticipate(state.customer, true)) return;
      if (!rule || !rule.id || !rule.action) return;

      var claimKey = activityIntentKeys[rule.id];
      if (!claimKey) {
        claimKey = crypto.randomUUID();
        activityIntentKeys[rule.id] = claimKey;
      }
      state.activityMessage = null;

      fetch(
        proxyPrefix + "/customer/activity/claim",
        requestOptions({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ruleId: rule.id, claimKey: claimKey }),
        }),
      )
        .then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok) {
              var error = new Error(
                payload?.error?.message ||
                  "Unable to complete this earning action.",
              );
              error.status = response.status;
              throw error;
            }
            return payload?.data || payload;
          });
        })
        .then(function (result) {
          if (destroyed || state.authenticationExpired) return;
          delete activityIntentKeys[rule.id];
          state.activityMessage = result.alreadyCompleted
            ? rule.name + " was already completed for this earning period."
            : "+" + result.pointsAwarded + " points added.";
          var activitySummaryEpoch = ++customerSummaryEpoch;
          customerRequest = null;
          // This read may supersede a post-redemption read. Until the newest
          // authoritative summary succeeds, no cached balance is spendable.
          state.customerError = translate(
            "Your member balance is temporarily unavailable.",
          );
          render();
          return shared
            .fetchJson(
              proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
              requestOptions(),
            )
            .then(shared.normalizeCustomer)
            .then(function (customer) {
              if (
                destroyed ||
                state.authenticationExpired ||
                activitySummaryEpoch !== customerSummaryEpoch
              )
                return;
              state.customer = customer;
              state.customerError = null;
            });
        })
        .catch(function (error) {
          if (destroyed || state.authenticationExpired) return;
          if (error?.status === 401 || error?.status === 403) {
            expireAuthentication();
            return;
          }
          state.activityMessage =
            error.message || "Unable to complete this earning action.";
        })
        .finally(function () {
          render();
        });
    }

    function renderFriendClaim() {
      var offer = activeReferralOffer(state.program);
      if (!capturedReferralCode) return "";
      if (!offer) {
        return (
          '<div class="weletic-guest-box">' +
          '<h4 class="weletic-guest-title">You were invited</h4>' +
          '<p class="weletic-guest-desc">This referral offer is not currently available.</p>' +
          "</div>"
        );
      }
      if (offer.friendRewardKind === "points") {
        var friendPointsBenefit = referralBenefit(
          offer,
          "friend",
          state.program?.program?.pointNameSingular || "Point",
          state.program?.program?.pointNamePlural || "Points",
        );
        return (
          '<div class="weletic-guest-box">' +
          '<h4 class="weletic-guest-title">You were invited</h4>' +
          '<p class="weletic-guest-desc">Create an account with the email you use at checkout and complete your first qualifying order to receive ' +
          escapeHtml(friendPointsBenefit) +
          ".</p>" +
          '<a href="' +
          escapeHtml(registerUrl) +
          '" class="weletic-btn-primary">Create account</a>' +
          '<a href="' +
          escapeHtml(loginUrl) +
          '" class="weletic-btn-secondary">Sign in</a>' +
          "</div>"
        );
      }
      if (state.friendClaim?.status === "claimed") {
        return (
          '<div class="weletic-guest-box">' +
          '<h4 class="weletic-guest-title">Your reward is ready</h4>' +
          '<p class="weletic-guest-desc">Use this one-time code on your first order. You do not need to create an account.</p>' +
          '<div class="weletic-wallet-code">' +
          escapeHtml(state.friendClaim.discountCode) +
          "</div>" +
          '<div class="weletic-wallet-actions">' +
          '<button type="button" class="weletic-btn-redeem" data-copy-code="' +
          escapeHtml(state.friendClaim.discountCode) +
          ('">' + translate("Copy code") + "</button>") +
          '<a class="weletic-wallet-apply" href="' +
          escapeHtml(state.friendClaim.applyUrl) +
          '">Apply reward</a>' +
          "</div>" +
          (state.friendClaim.emailSent
            ? '<p class="weletic-guest-desc weletic-referral-note">We also emailed the code to you.</p>'
            : '<p class="weletic-guest-desc weletic-referral-note">Save this code now; email delivery is temporarily unavailable.</p>') +
          "</div>"
        );
      }
      if (state.friendClaim?.status === "review") {
        return (
          '<div class="weletic-guest-box">' +
          '<h4 class="weletic-guest-title">Claim received</h4>' +
          '<p class="weletic-guest-desc">This invitation needs a quick eligibility review. No coupon was issued yet.</p>' +
          "</div>"
        );
      }
      var errorMessage =
        state.friendClaim?.status === "error"
          ? '<p class="weletic-referral-error" role="alert">' +
            escapeHtml(state.friendClaim.message) +
            "</p>"
          : "";
      return (
        '<div class="weletic-guest-box">' +
        '<h4 class="weletic-guest-title">A friend sent you a reward</h4>' +
        '<p class="weletic-guest-desc">Enter the email you will use at checkout to receive ' +
        escapeHtml(offer.friendRewardName || "your welcome reward") +
        ".</p>" +
        '<form id="weletic-friend-claim-form" class="weletic-referral-form">' +
        '<label for="weletic-friend-email">Email address</label>' +
        '<input id="weletic-friend-email" name="email" type="email" autocomplete="email" maxlength="320" required>' +
        errorMessage +
        '<button type="submit" class="weletic-btn-primary" ' +
        (state.friendClaim?.status === "loading" ? "disabled" : "") +
        ">" +
        (state.friendClaim?.status === "loading"
          ? "Claiming reward…"
          : "Claim my reward") +
        "</button>" +
        "</form>" +
        '<p class="weletic-guest-desc weletic-referral-note">New customers only. The code is unique and can be used once.</p>' +
        "</div>"
      );
    }

    function render() {
      if (destroyed) return;
      var focused = drawer.contains(document.activeElement)
        ? document.activeElement
        : null;
      var focusedId = focused?.id;
      var focusedTab = focused?.getAttribute("data-tab");
      var focusedReward = focused?.getAttribute("data-redeem-id");
      var loyaltyData = state.customer;
      var customerSummary = shared?.customerView(loyaltyData) || null;
      var isMember = isLoggedIn && Boolean(customerSummary);
      var points = customerSummary?.pointsBalance;
      var pending = customerSummary?.pendingPoints;
      var tierName = customerSummary?.tierName;
      var pointNameSingular =
        customerSummary?.pointNameSingular ||
        state.program?.program?.pointNameSingular ||
        "Point";
      var pointNamePlural =
        customerSummary?.pointNamePlural ||
        state.program?.program?.pointNamePlural ||
        "Points";
      var panelTitle =
        state.program?.branding?.panelTitle || translate("Rewards Club");
      var configuredSubtitle = state.program?.branding?.panelWelcomeSubtitle;
      var subtitle =
        typeof configuredSubtitle === "string"
          ? configuredSubtitle
          : translate("Earn points, level up, and unlock rewards.");
      var programActive = isProgramActive(state.program);
      var canParticipate = customerCanParticipate(loyaltyData, programActive);
      var referralOffer = activeReferralOffer(state.program);
      var referralActionsAvailable =
        Boolean(referralOffer) && (!isLoggedIn || canParticipate);
      if (
        !programActive ||
        (state.activeTab === "refer" && !referralActionsAvailable)
      ) {
        state.activeTab = "home";
      }

      var earnRules = programActive ? state.program?.earningRules || [] : [];
      var availableProgramRewards = (state.program?.rewards || []).filter(
        isOnlineStoreReward,
      );
      var rewardsList = programActive ? availableProgramRewards : [];
      var rewardWallet = loyaltyData?.rewardWallet || [];
      var availableWallet = rewardWallet.filter(function (reward) {
        return reward.status === "available";
      });
      var rewardHistory = rewardWallet.filter(function (reward) {
        return reward.status !== "available";
      });

      var referralLink = customerSummary?.referralShareUrl || null;

      var html = "";

      // Header
      html += '<div class="weletic-drawer-header">';
      html +=
        '<button type="button" class="weletic-close-btn" aria-label="' +
        escapeHtml(translate("Close")) +
        '">&times;</button>';
      var greetingHeader = escapeHtml(panelTitle);
      drawer.setAttribute("aria-label", panelTitle);
      html += '<h3 class="weletic-header-title">' + greetingHeader + "</h3>";
      html +=
        '<p class="weletic-header-subtitle">' + escapeHtml(subtitle) + "</p>";

      if (isMember && !state.customerError) {
        html += '<div class="weletic-user-card">';
        html += "  <div>";
        html +=
          '    <div class="weletic-points-val">' +
          formatNumber(points) +
          "</div>";
        html +=
          '    <div class="weletic-points-lbl">' +
          translate("Available Points") +
          (pending > 0
            ? escapeHtml(
                translate(" (+{points} pending)", {
                  points: formatNumber(pending),
                }),
              )
            : "") +
          "</div>";
        html += "  </div>";
        html +=
          '  <div class="weletic-tier-badge">👑 ' +
          escapeHtml(tierName) +
          "</div>";
        html += "</div>";
      }
      html += "</div>";

      var isInitialLoading =
        state.loading && (!state.program || (isLoggedIn && !customerSummary));
      if (isInitialLoading) {
        html +=
          '<div class="weletic-drawer-body"><div class="weletic-load-state" role="status"><div class="weletic-spinner"></div><span>' +
          translate("Loading your rewards...") +
          "</span></div></div>";
      } else if (state.error) {
        html +=
          '<div class="weletic-drawer-body"><div class="weletic-load-state weletic-load-error" role="alert"><strong>' +
          translate("Rewards are temporarily unavailable.") +
          "</strong><span>" +
          escapeHtml(state.error) +
          ('</span><button type="button" class="weletic-btn-load-retry" id="weletic-widget-retry">' +
            translate("Try again") +
            "</button></div></div>");
      } else {
        // Navigation tabs (if logged in or exploring)
        if (programActive) {
          html += '<div class="weletic-tab-nav">';
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "home" ? "weletic-active" : "") +
            ('" data-tab="home">' + translate("Home") + "</button>");
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "earn" ? "weletic-active" : "") +
            ('" data-tab="earn">' + translate("Earn") + "</button>");
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "redeem" ? "weletic-active" : "") +
            ('" data-tab="redeem">' + translate("Redeem") + "</button>");
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "vip" ? "weletic-active" : "") +
            '" data-tab="vip">VIP</button>';
          if (referralActionsAvailable) {
            html +=
              '<button type="button" class="weletic-tab-btn ' +
              (state.activeTab === "refer" ? "weletic-active" : "") +
              ('" data-tab="refer">' + translate("Refer") + "</button>");
          }
          html += "</div>";
        }

        // Body
        html += '<div class="weletic-drawer-body">';

        if (state.customerError) {
          html +=
            '<div class="weletic-load-error weletic-member-load-error" role="alert">' +
            escapeHtml(state.customerError) +
            "</div>";
          html += state.authenticationExpired
            ? '<a class="weletic-btn-secondary" href="' +
              escapeHtml(loginUrl) +
              ('">' + translate("Sign In") + "</a>")
            : '<button type="button" class="weletic-btn-load-retry" id="weletic-customer-retry">' +
              translate("Refresh balance") +
              "</button>";
        }

        if (state.redemptionMessage) {
          html +=
            '<div class="weletic-load-error" role="alert">' +
            escapeHtml(state.redemptionMessage) +
            "</div>";
        }

        if (state.confirmation) {
          html +=
            '<section class="weletic-redemption-confirmation" aria-label="' +
            escapeHtml(translate("Confirm redemption")) +
            '">' +
            ("<h4>" + translate("Confirm redemption") + "</h4><p>") +
            escapeHtml(state.confirmation.name) +
            "</p><p>" +
            escapeHtml(
              translate("{points} points will be spent.", {
                points: formatNumber(state.confirmation.pointsCost),
              }),
            ) +
            "</p>" +
            ('<button type="button" class="weletic-btn-primary" id="weletic-confirm-redemption">' +
              translate("Confirm redemption") +
              "</button>") +
            ('<button type="button" class="weletic-btn-secondary" id="weletic-cancel-redemption">' +
              translate("Cancel") +
              "</button></section>");
        }

        if (isMember && !canParticipate) {
          html +=
            '<div class="weletic-load-error weletic-account-restricted" role="status">' +
            translate(
              "Your loyalty account is currently unavailable for earning, redemption, and referrals. Existing wallet rewards and history remain visible.",
            ) +
            "</div>";
        }

        if (state.programError) {
          html +=
            '<div class="weletic-load-error weletic-program-load-error" role="alert">' +
            escapeHtml(state.programError) +
            ('<button type="button" class="weletic-btn-load-retry" id="weletic-widget-retry">' +
              translate("Try again") +
              "</button></div>");
        } else if (state.program && !programActive) {
          html +=
            '<div class="weletic-load-error weletic-program-paused" role="status">' +
            translate("This rewards program is currently unavailable.") +
            "</div>";
        }

        if (
          !isMember &&
          state.activeTab === "home" &&
          !state.customerError &&
          !state.authenticationExpired
        ) {
          if (!isLoggedIn && programActive && capturedReferralCode) {
            html += renderFriendClaim();
          }
          if (programActive) {
            html += '<div class="weletic-guest-box">';
            html +=
              '  <h4 class="weletic-guest-title">' +
              (isLoggedIn
                ? translate("Join the Rewards Club")
                : translate("Become a VIP Member")) +
              "</h4>";
            html +=
              '  <p class="weletic-guest-desc">' +
              (isLoggedIn
                ? translate(
                    "Your signed-in account is not enrolled in rewards yet. Join the program before earning or redeeming points.",
                  )
                : translate(
                    "Join our rewards program to earn points on every purchase and unlock exclusive vouchers.",
                  )) +
              "</p>";
            if (!isLoggedIn) {
              html +=
                '  <a href="' +
                escapeHtml(registerUrl) +
                ('" class="weletic-btn-primary">' +
                  translate("Create Account & Earn Points") +
                  "</a>");
              html +=
                '  <a href="' +
                escapeHtml(loginUrl) +
                ('" class="weletic-btn-secondary">' +
                  translate("Sign In") +
                  "</a>");
            }
            html += "</div>";
          }
        } else if (
          state.activeTab === "home" &&
          (isMember || state.lastRedeemedArtifact)
        ) {
          if (state.lastRedeemedArtifact) {
            var redeemedKind = state.lastRedeemedArtifact.artifactKind;
            var redeemedCode = state.lastRedeemedArtifact.artifactCode;
            html +=
              '<div role="status" style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px;border-radius:12px;margin-bottom:12px;text-align:center;">';
            html +=
              '  <div style="font-size:11px;color:#166534;font-weight:600;">' +
              translate("Reward Redeemed!") +
              "</div>";
            if (redeemedKind === "store_credit") {
              html +=
                '  <div style="font-size:12px;color:#166534;margin-top:4px;">' +
                translate(
                  "Store credit was added to your Shopify customer balance.",
                ) +
                "</div>";
            } else if (redeemedCode) {
              html +=
                '  <div style="font-size:16px;font-weight:800;font-family:monospace;color:#15803d;margin:4px 0;">' +
                escapeHtml(redeemedCode) +
                "</div>";
              html +=
                '  <div style="font-size:10px;color:#166534;">' +
                (redeemedKind === "gift_card"
                  ? translate("Use this gift card at checkout")
                  : translate("Use this discount code at checkout")) +
                "</div>";
            }
            html += "</div>";
          }

          if (!state.customerError) {
            html +=
              '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">' +
              translate("Your Rewards") +
              "</div>";
            if (availableWallet.length === 0) {
              html +=
                '<div class="weletic-wallet-empty">' +
                translate("You have no available coupons.") +
                "</div>";
            }
            availableWallet.forEach(function (reward) {
              var expiryDate = formatRewardDate(reward.expiresAt);
              var artifactKind = rewardArtifactKind(reward);
              var artifactCode = rewardArtifactCode(reward);
              html += '<div class="weletic-wallet-card">';
              html += '<div class="weletic-wallet-heading">';
              html +=
                '<div class="weletic-card-title">' +
                escapeHtml(reward.rewardName) +
                "</div>";
              html +=
                '<div class="weletic-wallet-status weletic-wallet-available">' +
                translate("Available") +
                "</div>";
              html += "</div>";
              html +=
                '<div class="weletic-card-desc">' +
                escapeHtml(rewardArtifactLabel(reward)) +
                "</div>";
              html +=
                '<div class="weletic-wallet-code">' +
                (artifactKind === "store_credit"
                  ? translate("Added to your customer balance")
                  : escapeHtml(
                      artifactCode || translate("Available in your account"),
                    )) +
                "</div>";
              html +=
                '<div class="weletic-card-desc">' +
                escapeHtml(
                  translate("{points} points", {
                    points: formatNumber(reward.pointsSpent),
                  }),
                ) +
                (expiryDate
                  ? escapeHtml(
                      translate(" · Expires {date}", { date: expiryDate }),
                    )
                  : "") +
                "</div>";
              if (canParticipate && (artifactCode || reward.applyUrl)) {
                html += '<div class="weletic-wallet-actions">';
                if (artifactCode) {
                  html +=
                    '<button type="button" class="weletic-btn-redeem" data-copy-code="' +
                    escapeHtml(artifactCode) +
                    ('">' + translate("Copy code") + "</button>");
                }
                if (reward.applyUrl) {
                  html +=
                    '<a class="weletic-wallet-apply" href="' +
                    escapeHtml(reward.applyUrl) +
                    ('" target="_blank" rel="noopener">' +
                      translate("Use reward") +
                      "</a>");
                }
                html += "</div>";
              }
              html += "</div>";
            });

            if (rewardHistory.length > 0) {
              html +=
                '<div style="font-size:12px;font-weight:700;margin:14px 0 8px;color:#111827;">' +
                translate("Reward History") +
                "</div>";
              rewardHistory.forEach(function (reward) {
                var activityDate = formatRewardDate(reward.statusDate);
                var artifactCode = rewardArtifactCode(reward);
                html += '<div class="weletic-wallet-card">';
                html += '<div class="weletic-wallet-heading">';
                html +=
                  '<div class="weletic-card-title">' +
                  escapeHtml(reward.rewardName) +
                  "</div>";
                html +=
                  '<div class="weletic-wallet-status">' +
                  escapeHtml(rewardStatusLabel(reward.status)) +
                  "</div>";
                html += "</div>";
                html +=
                  '<div class="weletic-card-desc">' +
                  escapeHtml(rewardArtifactLabel(reward)) +
                  (artifactCode ? " " + escapeHtml(artifactCode) : "") +
                  (activityDate ? " · " + escapeHtml(activityDate) : "") +
                  (reward.orderName
                    ? escapeHtml(
                        translate(" · Order {order}", {
                          order: reward.orderName,
                        }),
                      )
                    : "") +
                  "</div>";
                html += "</div>";
              });
            }
          }

          if (programActive) {
            html +=
              '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">' +
              translate("Quick Rewards") +
              "</div>";
            rewardsList.slice(0, 2).forEach(function (rew) {
              var rewardValue = formatShopperRewardValue(rew);
              var rewardType = translate(
                shared.rewardTypeLabel(rew.rewardType),
              );
              var rewardSummary =
                rewardValue === rewardType
                  ? rewardType
                  : rewardType + " · " + rewardValue;
              var pointOptions = rewardPointOptions(rew, points);
              var isIncremental = pointOptions.incremental;
              var minimumPoints = pointOptions.minimum;
              var maximumPoints = pointOptions.maximum || minimumPoints;
              var pointsStep = pointOptions.step;
              var canRedeem =
                canParticipate &&
                pointOptions.canRedeem &&
                !state.customerError;
              html += '<div class="weletic-card-item">';
              html += "  <div>";
              html +=
                '    <div class="weletic-card-title">' +
                escapeHtml(rew.name) +
                "</div>";
              html +=
                '    <div class="weletic-card-desc">' +
                escapeHtml(rewardSummary) +
                "</div>";
              html +=
                '    <div class="weletic-card-desc">' +
                (isIncremental ? translate("From ") : "") +
                escapeHtml(
                  translate("{points} points", {
                    points: formatNumber(minimumPoints),
                  }),
                ) +
                "</div>";
              if (isIncremental) {
                html +=
                  '    <input class="weletic-reward-points-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="' +
                  escapeHtml(translate("Points to redeem")) +
                  '" data-reward-points data-minimum-points="' +
                  minimumPoints +
                  '" data-maximum-points="' +
                  maximumPoints +
                  '" data-points-step="' +
                  pointsStep +
                  '" value="' +
                  minimumPoints +
                  '" ' +
                  (state.mutationPending || !canParticipate ? "disabled" : "") +
                  '">';
              }
              html += "  </div>";
              html +=
                '  <button type="button" class="weletic-btn-redeem" ' +
                (state.mutationPending || state.confirmation || !canRedeem
                  ? "disabled"
                  : "") +
                ' data-redeem-id="' +
                escapeHtml(rew.id) +
                '">' +
                (state.mutationPending
                  ? translate("Redeeming…")
                  : canRedeem
                    ? translate("Redeem")
                    : !canParticipate && isMember
                      ? translate("Account unavailable")
                      : state.customerError
                        ? translate("Balance unavailable")
                        : !isMember
                          ? translate("Members only")
                          : translate("Need more pts")) +
                "</button>";
              html += "</div>";
            });
          }
        } else if (state.activeTab === "earn") {
          html +=
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">' +
            translate("Ways to Earn Points") +
            "</div>";
          if (state.activityMessage) {
            html +=
              '<div class="weletic-wallet-empty" role="status">' +
              escapeHtml(state.activityMessage) +
              "</div>";
          }
          earnRules.forEach(function (rule) {
            html += '<div class="weletic-card-item">';
            html += "  <div>";
            html +=
              '    <div class="weletic-card-title">' +
              escapeHtml(rule.name) +
              "</div>";
            html +=
              '    <div class="weletic-card-desc">' +
              escapeHtml(rule.description || "Earn rewards on activity") +
              "</div>";
            html += "  </div>";
            html += "  <div>";
            html +=
              '    <div class="weletic-card-badge">' +
              escapeHtml(
                shared.formatEarningValue(
                  rule,
                  pointNameSingular,
                  pointNamePlural,
                  {
                    pointsPerCurrencyUnit:
                      state.program?.program?.pointsPerCurrencyUnit,
                    currency: state.program?.currency || currency,
                  },
                ),
              ) +
              "</div>";
            if (rule.action) {
              html += canParticipate
                ? '    <a class="weletic-wallet-apply" data-activity-id="' +
                  escapeHtml(rule.id) +
                  '" href="' +
                  escapeHtml(rule.action.url) +
                  '" target="_blank" rel="noopener noreferrer">' +
                  escapeHtml(rule.action.label || "Open") +
                  "</a>"
                : isLoggedIn
                  ? '    <span class="weletic-card-desc">' +
                    (isMember
                      ? translate("Account unavailable")
                      : translate("Members only")) +
                    "</span>"
                  : '    <a class="weletic-wallet-apply" href="' +
                    escapeHtml(loginUrl) +
                    '">Sign in</a>';
            }
            html += "  </div>";
            html += "</div>";
            if (rule.action) {
              html +=
                '<p class="weletic-card-desc">Points are awarded when the signed customer opens this action. Social completion is not confirmed by the network.</p>';
            }
          });
        } else if (state.activeTab === "redeem") {
          html +=
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">' +
            translate("Redeem Points for Rewards") +
            "</div>";
          rewardsList.forEach(function (rew) {
            var rewardValue = formatShopperRewardValue(rew);
            var rewardType = translate(shared.rewardTypeLabel(rew.rewardType));
            var rewardSummary =
              rewardValue === rewardType
                ? rewardType
                : rewardType + " · " + rewardValue;
            var pointOptions = rewardPointOptions(rew, points);
            var isIncremental = pointOptions.incremental;
            var minimumPoints = pointOptions.minimum;
            var maximumPoints = pointOptions.maximum || minimumPoints;
            var pointsStep = pointOptions.step;
            var canRedeem =
              canParticipate && pointOptions.canRedeem && !state.customerError;
            html += '<div class="weletic-card-item">';
            html += "  <div>";
            html +=
              '    <div class="weletic-card-title">' +
              escapeHtml(rew.name) +
              "</div>";
            html +=
              '    <div class="weletic-card-desc">' +
              escapeHtml(rewardSummary) +
              "</div>";
            html +=
              '    <div class="weletic-card-desc">' +
              (isIncremental ? translate("From ") : "") +
              escapeHtml(
                translate("{points} points", {
                  points: formatNumber(minimumPoints),
                }),
              ) +
              "</div>";
            if (isIncremental) {
              html +=
                '    <input class="weletic-reward-points-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="' +
                escapeHtml(translate("Points to redeem")) +
                '" data-reward-points data-minimum-points="' +
                minimumPoints +
                '" data-maximum-points="' +
                maximumPoints +
                '" data-points-step="' +
                pointsStep +
                '" value="' +
                minimumPoints +
                '" ' +
                (state.mutationPending || !canParticipate ? "disabled" : "") +
                '">';
            }
            html += "  </div>";
            html +=
              '  <button type="button" class="weletic-btn-redeem" ' +
              (state.mutationPending || state.confirmation || !canRedeem
                ? "disabled"
                : "") +
              ' data-redeem-id="' +
              escapeHtml(rew.id) +
              '">' +
              (state.mutationPending
                ? translate("Redeeming…")
                : canRedeem
                  ? translate("Redeem")
                  : !canParticipate && isMember
                    ? translate("Account unavailable")
                    : state.customerError
                      ? translate("Balance unavailable")
                      : !isMember
                        ? translate("Members only")
                        : translate("Need pts")) +
              "</button>";
            html += "</div>";
          });
        } else if (state.activeTab === "vip") {
          html +=
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">' +
            translate("VIP Tier Benefits") +
            "</div>";
          var tiersList = state.program?.tiers || [];
          tiersList.forEach(function (t) {
            html += '<div class="weletic-card-item">';
            html += "  <div>";
            html +=
              '    <div class="weletic-card-title">👑 ' +
              escapeHtml(t.name) +
              "</div>";
            html +=
              '    <div class="weletic-card-desc">' +
              escapeHtml(formatTierRequirement(t)) +
              "</div>";
            html += "  </div>";
            html +=
              '  <div class="weletic-card-badge">' +
              Number(t.pointsMultiplier ?? t.multiplier ?? 1.0) +
              "x pts</div>";
            html += "</div>";
          });
        } else if (state.activeTab === "refer" && referralActionsAvailable) {
          if (!isLoggedIn && capturedReferralCode) {
            html += renderFriendClaim();
          } else if (!isLoggedIn) {
            html += '<div class="weletic-guest-box">';
            html += '<h4 class="weletic-guest-title">Refer friends</h4>';
            html +=
              '<p class="weletic-guest-desc">Sign in to get your personal referral link.</p>';
            html +=
              '<a href="' +
              escapeHtml(loginUrl) +
              '" class="weletic-btn-primary">Sign in</a>';
            html += "</div>";
          } else if (!isMember) {
            html +=
              '<div class="weletic-load-state"><strong>Join rewards to refer friends.</strong><span>Your signed-in account is not enrolled yet.</span></div>';
          } else if (referralLink) {
            var friendBenefit = referralBenefit(
              referralOffer,
              "friend",
              pointNameSingular,
              pointNamePlural,
            );
            var advocateBenefit = referralBenefit(
              referralOffer,
              "advocate",
              pointNameSingular,
              pointNamePlural,
            );
            html +=
              '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">Refer Friends, Earn Rewards</div>';
            html +=
              '<p style="font-size:11px;color:#6b7280;margin-bottom:12px;">Give your friend ' +
              escapeHtml(friendBenefit) +
              " on their first qualifying order. Earn " +
              escapeHtml(advocateBenefit) +
              " when that order qualifies.</p>";
            html +=
              '<div style="background:#f9fafb;padding:10px;border-radius:10px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;word-break:break-all;margin-bottom:8px;">' +
              escapeHtml(referralLink) +
              "</div>";
            html +=
              '<button type="button" class="weletic-btn-primary" id="weletic-copy-referral-btn">Copy Referral Link</button>';
          } else {
            html +=
              '<div class="weletic-load-state"><strong>Your referral link is not available yet.</strong><span>Please try again later.</span></div>';
          }
        }

        html += "</div>";
      }

      drawer.innerHTML = html;

      // Bind dynamic elements
      var closeBtn = drawer.querySelector(".weletic-close-btn");
      if (closeBtn) {
        closeBtn.addEventListener("click", function () {
          toggleDrawer(false);
        });
      }

      var retryButton = drawer.querySelector("#weletic-widget-retry");
      if (retryButton) {
        retryButton.addEventListener("click", fetchProgramData);
      }
      var customerRetry = drawer.querySelector("#weletic-customer-retry");
      if (customerRetry)
        customerRetry.addEventListener("click", fetchProgramData);

      var confirmButton = drawer.querySelector("#weletic-confirm-redemption");
      if (confirmButton)
        confirmButton.addEventListener("click", function () {
          var selection = state.confirmation;
          if (!selection || state.mutationPending) return;
          state.confirmation = null;
          redeemReward(selection.rewardId, selection.pointsRequested);
        });
      var cancelButton = drawer.querySelector("#weletic-cancel-redemption");
      if (cancelButton)
        cancelButton.addEventListener("click", cancelRedemption);

      var tabButtons = drawer.querySelectorAll(".weletic-tab-btn");
      tabButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.confirmation = null;
          state.activeTab = btn.getAttribute("data-tab");
          render();
        });
      });

      var redeemButtons = drawer.querySelectorAll("[data-redeem-id]");
      redeemButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (btn.disabled || state.mutationPending || state.confirmation)
            return;
          var rewId = btn.getAttribute("data-redeem-id");
          var card = btn.closest(".weletic-card-item");
          var pointsInput = card?.querySelector("[data-reward-points]");
          var pointsRequested;
          if (pointsInput) {
            pointsRequested = pointsInput.value.trim();
            if (
              !isValidPointSelection(
                pointsRequested,
                pointsInput.getAttribute("data-minimum-points"),
                pointsInput.getAttribute("data-maximum-points"),
                pointsInput.getAttribute("data-points-step"),
              )
            ) {
              alert(
                translate(
                  "Choose a valid points amount within the reward limits.",
                ),
              );
              return;
            }
          }
          var selectedReward = rewardsList.find(function (reward) {
            return reward.id === rewId;
          });
          if (!selectedReward || !canParticipate || state.customerError) return;
          state.confirmation = {
            rewardId: rewId,
            name: selectedReward.name,
            pointsRequested: pointsRequested,
            pointsCost:
              pointsRequested === undefined
                ? selectedReward.pointsCost
                : pointsRequested,
          };
          render();
          drawer.querySelector("#weletic-cancel-redemption")?.focus();
        });
      });

      var activityButtons = drawer.querySelectorAll("[data-activity-id]");
      activityButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          var ruleId = button.getAttribute("data-activity-id");
          var rule = earnRules.find(function (candidate) {
            return candidate.id === ruleId;
          });
          claimCustomerActivity(rule);
        });
      });

      var couponCopyButtons = drawer.querySelectorAll("[data-copy-code]");
      couponCopyButtons.forEach(function (btn) {
        var code = btn.getAttribute("data-copy-code");
        if (code)
          bindCopyButton(
            btn,
            code,
            translate("Copied!"),
            translate("Copy code"),
          );
      });

      var copyBtn = drawer.querySelector("#weletic-copy-referral-btn");
      if (copyBtn && referralLink) {
        bindCopyButton(
          copyBtn,
          referralLink,
          "Copied to Clipboard!",
          "Copy Referral Link",
        );
      }

      var friendClaimForm = drawer.querySelector("#weletic-friend-claim-form");
      if (friendClaimForm) {
        friendClaimForm.addEventListener("submit", function (event) {
          event.preventDefault();
          var emailInput = friendClaimForm.querySelector(
            "#weletic-friend-email",
          );
          claimFriendReward(emailInput?.value || "");
        });
      }
      if (state.isOpen) {
        var restore = Array.from(
          drawer.querySelectorAll("button, a, input"),
        ).find(function (element) {
          return (
            !element.disabled &&
            ((focusedId && element.id === focusedId) ||
              (focusedTab && element.getAttribute("data-tab") === focusedTab) ||
              (focusedReward &&
                element.getAttribute("data-redeem-id") === focusedReward))
          );
        });
        (restore || closeBtn || drawer).focus();
      }
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function formatNumber(num) {
      if (num === undefined || num === null) return "0";
      return shared
        ? shared.formatInteger(num, locale)
        : Number(num).toLocaleString(locale);
    }

    function destroy() {
      cartNudgeEvents.forEach(function (name) {
        document.removeEventListener(name, invalidateCartNudge, true);
      });
      if (destroyed) return;
      destroyed = true;
      dismissNudge(false);
      if (abortController) abortController.abort();
      timeoutIds.forEach(function (timeoutId) {
        window.clearTimeout(timeoutId);
      });
      timeoutIds = [];
      launcherBtn.removeEventListener("click", handleLauncherClick);
      overlay.removeEventListener("click", handleOverlayClick);
      document.removeEventListener("keydown", handleDrawerKeydown);
      [launcherBtn, overlay, drawer].forEach(function (node) {
        if (node.parentNode) node.parentNode.removeChild(node);
      });
    }

    return { destroy: destroy };
  }

  var mountedRoots = new Set();

  function rootsWithin(scope) {
    var roots = [];
    if (!scope) return roots;
    if (scope.matches && scope.matches(ROOT_SELECTOR)) roots.push(scope);
    if (scope.querySelectorAll) {
      scope.querySelectorAll(ROOT_SELECTOR).forEach(function (root) {
        if (roots.indexOf(root) === -1) roots.push(root);
      });
    }
    return roots;
  }

  function mountRoot(root) {
    if (root[CONTROLLER_KEY]) return root[CONTROLLER_KEY];
    var controller = initLoyaltyWidget(root);
    if (!controller) return null;
    Object.defineProperty(root, CONTROLLER_KEY, {
      configurable: true,
      value: controller,
    });
    mountedRoots.add(root);
    return controller;
  }

  function unmountRoot(root) {
    var controller = root && root[CONTROLLER_KEY];
    if (controller) controller.destroy();
    if (root) delete root[CONTROLLER_KEY];
    mountedRoots.delete(root);
  }

  function sweepDisconnectedRoots() {
    Array.from(mountedRoots).forEach(function (root) {
      if (!root.isConnected) unmountRoot(root);
    });
  }

  function mountAll(scope) {
    sweepDisconnectedRoots();
    rootsWithin(scope || document).forEach(mountRoot);
  }

  function unmountAll(scope) {
    rootsWithin(scope).forEach(unmountRoot);
  }

  function handleSectionLoad(event) {
    mountAll(event.target);
  }

  function handleSectionUnload(event) {
    unmountAll(event.target);
  }

  function handleReady() {
    mountAll(document);
  }

  var runtime = {
    mountAll: mountAll,
    unmountAll: unmountAll,
    dispose: function () {
      document.removeEventListener("DOMContentLoaded", handleReady);
      document.removeEventListener("shopify:section:load", handleSectionLoad);
      document.removeEventListener(
        "shopify:section:unload",
        handleSectionUnload,
      );
      Array.from(mountedRoots).forEach(unmountRoot);
      if (window[RUNTIME_KEY] === runtime) delete window[RUNTIME_KEY];
    },
  };

  window[RUNTIME_KEY] = runtime;
  document.addEventListener("shopify:section:load", handleSectionLoad);
  document.addEventListener("shopify:section:unload", handleSectionUnload);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleReady, { once: true });
  } else {
    mountAll(document);
  }
})();
