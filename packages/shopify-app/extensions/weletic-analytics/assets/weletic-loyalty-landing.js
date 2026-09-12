/**
 * Weletic Loyalty Landing Page Controller
 * Renders rewards landing section content dynamically.
 * Strictly compliant with Zero-PII DOM architecture.
 */
(function () {
  "use strict";

  var RUNTIME_KEY = "WeleticLoyaltyLandingRuntime";
  var CONTROLLER_KEY = "__weleticLoyaltyLandingController";
  var ROOT_SELECTOR =
    "[data-weletic-loyalty-landing-root], #weletic-loyalty-landing-root";

  // Interface copy only; merchant names, descriptions and branding stay intact.
  var COPY = {
    "Rewards could not start. Please refresh this page.": [
      "特典を表示できません。このページを再読み込みしてください。",
      "Không thể khởi động phần thưởng. Vui lòng tải lại trang.",
    ],
    "Loading your member rewards balance...": [
      "会員特典の残高を読み込み中…",
      "Đang tải số dư phần thưởng thành viên…",
    ],
    "Loading loyalty program details...": [
      "特典プログラムを読み込み中…",
      "Đang tải thông tin chương trình…",
    ],
    "We could not load program details.": [
      "プログラム情報を読み込めませんでした。",
      "Không thể tải thông tin chương trình.",
    ],
    "Your member balance and issued rewards are unaffected. Please try again.":
      [
        "会員残高と発行済み特典への影響はありません。再試行してください。",
        "Số dư và phần thưởng đã phát hành không bị ảnh hưởng. Vui lòng thử lại.",
      ],
    "Try again": ["再試行", "Thử lại"],
    "This rewards program is currently unavailable.": [
      "現在、この特典プログラムはご利用いただけません。",
      "Chương trình phần thưởng hiện không khả dụng.",
    ],
    "Please check back later.": [
      "しばらくしてから再度ご確認ください。",
      "Vui lòng quay lại sau.",
    ],
    "Your rewards balance is temporarily unavailable.": [
      "特典残高を一時的に取得できません。",
      "Số dư phần thưởng tạm thời không khả dụng.",
    ],
    "Available Balance:": ["利用可能残高：", "Số dư khả dụng:"],
    "VIP Tier:": ["VIPランク：", "Hạng VIP:"],
    "Your loyalty account is currently unavailable for earning, redemption, and referrals.":
      [
        "現在、この会員アカウントではポイント獲得・交換・紹介をご利用いただけません。",
        "Tài khoản hiện không thể tích điểm, đổi thưởng hoặc giới thiệu.",
      ],
    "Your signed-in account is not enrolled in rewards yet.": [
      "ログイン中のアカウントは特典プログラムに未登録です。",
      "Tài khoản đã đăng nhập chưa tham gia chương trình phần thưởng.",
    ],
    "Public program details remain available below.": [
      "公開プログラム情報は引き続き以下でご覧いただけます。",
      "Bạn vẫn có thể xem thông tin chương trình công khai bên dưới.",
    ],
    "Join Now & Earn Points": [
      "登録してポイントを貯める",
      "Tham gia và tích điểm",
    ],
    "Already a Member? Sign In": [
      "会員の方はこちらからログイン",
      "Đã là thành viên? Đăng nhập",
    ],
    "Ways to Earn Points": ["ポイントの貯め方", "Cách tích điểm"],
    "Accumulate points every time you interact with our store.": [
      "ストアでの対象アクションでポイントを貯めましょう。",
      "Tích điểm qua các hoạt động tại cửa hàng.",
    ],
    "Earn rewards on qualifying activity.": [
      "対象アクションで特典を獲得できます。",
      "Nhận phần thưởng từ hoạt động đủ điều kiện.",
    ],
    "VIP Tier Milestones": ["VIPランクの条件", "Điều kiện hạng VIP"],
    "Unlock higher points earning rates and premium benefits as you level up.":
      [
        "ランクアップすると、ポイント獲得率や特典が充実します。",
        "Nâng hạng để nhận tỷ lệ tích điểm và quyền lợi cao hơn.",
      ],
    "Points requirement: {points}": [
      "必要ポイント：{points}",
      "Điểm yêu cầu: {points}",
    ],
    "Spend: {spend} • Points: {points}": [
      "購入金額：{spend} • ポイント：{points}",
      "Chi tiêu: {spend} • Điểm: {points}",
    ],
    "Spend requirement: {spend}": [
      "必要購入金額：{spend}",
      "Chi tiêu yêu cầu: {spend}",
    ],
    "{multiplier}x Points Multiplier": [
      "ポイント倍率：{multiplier}倍",
      "Hệ số tích điểm: {multiplier} lần",
    ],
    "Ways to Redeem": ["ポイントの使い方", "Cách đổi thưởng"],
    "Exchange your points for available online rewards.": [
      "ポイントをオンラインで利用できる特典に交換しましょう。",
      "Đổi điểm lấy phần thưởng trực tuyến khả dụng.",
    ],
    "From {points}": ["{points}から", "Từ {points}"],
    "Refer Your Friends": ["友達を紹介する", "Giới thiệu bạn bè"],
    "Give your friend {friend} on their first qualifying order. Earn {advocate} when that order qualifies.":
      [
        "友達の初回対象注文で{friend}をプレゼント。注文が条件を満たすと、あなたに{advocate}を進呈します。",
        "Tặng bạn bè {friend} cho đơn hàng đầu tiên đủ điều kiện. Nhận {advocate} khi đơn hàng đó đạt điều kiện.",
      ],
    "Copy Referral Link": [
      "紹介リンクをコピー",
      "Sao chép liên kết giới thiệu",
    ],
    "Copied to Clipboard!": ["コピーしました！", "Đã sao chép!"],
    "Copy unavailable — select manually": [
      "コピーできません。リンクを選択してコピーしてください",
      "Không thể sao chép — hãy chọn liên kết thủ công",
    ],
    "Referrals are unavailable while your loyalty account is not active.": [
      "会員アカウントが有効でない間は紹介をご利用いただけません。",
      "Không thể giới thiệu khi tài khoản thành viên chưa hoạt động.",
    ],
    "Your referral link is not available yet. Please try again later.": [
      "紹介リンクをまだ取得できません。後ほど再試行してください。",
      "Liên kết giới thiệu chưa khả dụng. Vui lòng thử lại sau.",
    ],
    "Join rewards before creating a referral link.": [
      "紹介リンクを作成するには特典プログラムにご登録ください。",
      "Hãy tham gia chương trình trước khi tạo liên kết giới thiệu.",
    ],
    "Sign In to Get Referral Link": [
      "ログインして紹介リンクを取得",
      "Đăng nhập để nhận liên kết giới thiệu",
    ],
    Point: ["ポイント", "Điểm"],
    Points: ["ポイント", "Điểm"],
    "{points} per {amount}": [
      "{amount}ごとに{points}",
      "{points} cho mỗi {amount}",
    ],
    "Amount off": ["金額割引", "Giảm tiền"],
    "Percentage off": ["割合割引", "Giảm theo phần trăm"],
    "Free shipping": ["送料無料", "Miễn phí vận chuyển"],
    "Free product": ["無料商品", "Sản phẩm miễn phí"],
    "Gift card": ["ギフトカード", "Thẻ quà tặng"],
    "Store credit": ["ストアクレジット", "Tín dụng cửa hàng"],
    Reward: ["特典", "Phần thưởng"],
    "{amount} off": ["{amount}割引", "Giảm {amount}"],
    "{amount} gift card": ["{amount}のギフトカード", "Thẻ quà tặng {amount}"],
    "{amount} store credit": [
      "{amount}のストアクレジット",
      "Tín dụng cửa hàng {amount}",
    ],
  };

  if (window[RUNTIME_KEY]) {
    window[RUNTIME_KEY].mountAll(document);
    return;
  }

  function initLoyaltyLanding(root) {
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
      var variants = COPY[message];
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
    function copy(message, values) {
      return escapeHtml(translate(message, values));
    }
    var destroyed = false;
    var abortController =
      typeof window.AbortController === "function"
        ? new window.AbortController()
        : null;
    var timeoutIds = [];

    function requestOptions() {
      return abortController ? { signal: abortController.signal } : undefined;
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
    var proxyPrefix = root.getAttribute("data-proxy-prefix") || "/apps/weletic";
    var loginUrl = root.getAttribute("data-login-url") || "/account/login";
    var registerUrl =
      root.getAttribute("data-register-url") || "/account/register";
    var primaryColor = root.getAttribute("data-primary-color") || "#6366f1";
    var currency = root.getAttribute("data-currency") || "USD";
    var showTiers = root.getAttribute("data-show-tiers") !== "false";
    var showEarn = root.getAttribute("data-show-earn") !== "false";
    var showRedeem = root.getAttribute("data-show-redeem") !== "false";
    var showReferrals = root.getAttribute("data-show-referrals") !== "false";
    var showFaq = root.getAttribute("data-show-faq") !== "false";

    var contentContainer = root.querySelector(
      "[data-weletic-landing-sections], #weletic-landing-sections",
    );
    var authBanner = root.querySelector(
      "[data-weletic-landing-auth-banner], #weletic-landing-auth-banner",
    );
    var usesLegacyMarkup =
      root.id === "weletic-loyalty-landing-root" &&
      !root.hasAttribute("data-weletic-loyalty-landing-root");
    if (usesLegacyMarkup) {
      contentContainer =
        contentContainer || document.getElementById("weletic-landing-sections");
      authBanner =
        authBanner || document.getElementById("weletic-landing-auth-banner");
    }

    if (!shared) {
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-load-state weletic-load-error" role="alert">' +
          copy("Rewards could not start. Please refresh this page.") +
          "</div>";
      }
      return;
    }

    function formatMinorMoney(amount, currencyCode) {
      return shared.formatMinorMoney(amount, currencyCode || currency, locale);
    }

    function isProgramActive(program) {
      return program?.program?.isActive === true;
    }

    function hasPositivePoints(value) {
      return shared.isIntegerAtLeast(value, "1");
    }

    function activeReferralOffer(program) {
      if (!isProgramActive(program)) return null;
      var offer = program?.referralOffer;
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
      if (offer?.[audience + "RewardKind"] === "coupon") {
        return offer[audience + "RewardName"];
      }
      return shared.formatPoints(
        offer?.[audience + "PointsReward"],
        singular,
        plural,
        locale,
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

    function formatTierRequirement(program, tier) {
      var milestoneMode = program?.program?.vipMilestoneMode;
      var pointsRequirement = shared.formatInteger(
        tier.minPointsThreshold || 0,
        locale,
      );
      var spendRequirement = formatMinorMoney(
        tier.minSpendThreshold || 0,
        program?.currency,
      );

      if (milestoneMode === "points_earned") {
        return translate("Points requirement: {points}", {
          points: pointsRequirement,
        });
      }
      if (milestoneMode === "both") {
        return translate("Spend: {spend} • Points: {points}", {
          spend: spendRequirement,
          points: pointsRequirement,
        });
      }
      return translate("Spend requirement: {spend}", {
        spend: spendRequirement,
      });
    }

    function applyProgramBranding(program) {
      if (destroyed) return;
      var branding = program?.branding || {};
      primaryColor = branding.primaryColor || primaryColor;
      root.style.setProperty("--weletic-primary", primaryColor);
      document.documentElement.style.setProperty(
        "--weletic-primary",
        primaryColor,
      );

      var hero = root.querySelector(".weletic-landing-hero");
      var title = root.querySelector(".weletic-landing-title");
      var subtitle = root.querySelector(".weletic-landing-subtitle");
      if (title && branding.panelTitle) {
        title.textContent = branding.panelTitle;
      }
      if (subtitle && typeof branding.panelWelcomeSubtitle === "string") {
        subtitle.textContent = branding.panelWelcomeSubtitle;
      }
      if (hero && branding.heroImageUrl) {
        hero.classList.add("weletic-landing-hero-branded");
        hero.style.backgroundImage =
          "url(" + JSON.stringify(branding.heroImageUrl) + ")";
        hero.style.backgroundColor = "rgba(17, 24, 39, 0.42)";
        hero.style.backgroundBlendMode = "multiply";
        if (title) title.style.color = branding.headerTextColor || "#ffffff";
        if (subtitle) {
          subtitle.style.color = branding.headerTextColor || "#ffffff";
        }
      }
    }

    function renderLoading() {
      if (destroyed) return;
      if (isLoggedIn && authBanner) {
        authBanner.innerHTML =
          '<div class="weletic-landing-user-badge" role="status"><span class="weletic-spinner-sm"></span> ' +
          copy("Loading your member rewards balance...") +
          "</div>";
      }
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-loading-placeholder" role="status"><div class="weletic-spinner"></div><p>' +
          copy("Loading loyalty program details...") +
          "</p></div>";
      }
    }

    function renderProgramLoadError(customer, customerError) {
      if (destroyed) return;
      renderAuthBanner(customer, customerError);
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-load-state weletic-load-error" role="alert"><strong>' +
          copy("We could not load program details.") +
          "</strong><span>" +
          copy(
            "Your member balance and issued rewards are unaffected. Please try again.",
          ) +
          '</span><button type="button" class="weletic-btn-load-retry" id="weletic-landing-retry">' +
          copy("Try again") +
          "</button></div>";
        var retryButton = contentContainer.querySelector(
          "#weletic-landing-retry",
        );
        if (retryButton) retryButton.addEventListener("click", loadData);
      }
    }

    function renderProgramPaused() {
      if (destroyed) return;
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-load-state weletic-load-error" role="status"><strong>' +
          copy("This rewards program is currently unavailable.") +
          "</strong><span>" +
          copy("Please check back later.") +
          "</span></div>";
      }
    }

    function loadData() {
      renderLoading();

      var programPromise = shared
        .fetchJson(
          proxyPrefix + "/program?shop=" + encodeURIComponent(shop),
          requestOptions(),
        )
        .then(shared.normalizeProgram);
      var customerPromise = isLoggedIn
        ? shared
            .fetchJson(
              proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
              requestOptions(),
            )
            .then(shared.normalizeCustomer)
        : Promise.resolve(null);

      Promise.allSettled([programPromise, customerPromise])
        .then(function (results) {
          if (destroyed) return;
          var programResult = results[0];
          var customerResult = results[1];
          var customer =
            customerResult.status === "fulfilled" ? customerResult.value : null;
          var customerError =
            customerResult.status === "rejected"
              ? translate("Your rewards balance is temporarily unavailable.")
              : null;
          if (programResult.status === "rejected") {
            console.warn(
              "[Weletic Landing] Program data unavailable",
              programResult.reason,
            );
            renderProgramLoadError(customer, customerError);
            return;
          }
          var program = programResult.value;
          applyProgramBranding(program);
          renderAuthBanner(customer, customerError);
          if (!isProgramActive(program)) {
            renderProgramPaused();
            return;
          }
          renderSections(program, customer);
        })
        .catch(function (error) {
          if (destroyed) return;
          console.warn("[Weletic Landing] Error loading data", error);
          renderProgramLoadError(
            null,
            translate("Your rewards balance is temporarily unavailable."),
          );
        });
    }

    loadData();

    function renderAuthBanner(customer, errorMessage) {
      if (destroyed) return;
      if (!authBanner) return;
      var view = shared.customerView(customer);
      var canParticipate = shared.customerCanParticipate(
        customer,
        customer?.program?.isActive === true,
      );
      if (isLoggedIn && view) {
        authBanner.innerHTML =
          '<div class="weletic-landing-balance" style="display:inline-flex;align-items:center;flex-wrap:wrap;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;gap:12px;background:#f3f4f6;padding:10px 20px;border-radius:9999px;font-size:14px;color:#111827;">' +
          "  <span>" +
          copy("Available Balance:") +
          ' <strong style="color:' +
          primaryColor +
          ';">' +
          escapeHtml(
            shared.formatPoints(
              view.pointsBalance,
              view.pointNameSingular,
              view.pointNamePlural,
              locale,
            ),
          ) +
          "</strong></span>" +
          "  <span>•</span>" +
          "  <span>" +
          copy("VIP Tier:") +
          " <strong>" +
          escapeHtml(view.tierName) +
          "</strong></span>" +
          "</div>" +
          (!canParticipate
            ? '<div class="weletic-load-error" role="status">' +
              copy(
                "Your loyalty account is currently unavailable for earning, redemption, and referrals.",
              ) +
              "</div>"
            : "");
      } else if (isLoggedIn && customer?.isEnrolled === false) {
        authBanner.innerHTML =
          '<div class="weletic-landing-user-badge" role="status">' +
          copy("Your signed-in account is not enrolled in rewards yet.") +
          "</div>";
      } else if (isLoggedIn && errorMessage) {
        authBanner.innerHTML =
          '<div class="weletic-load-error" role="alert">' +
          escapeHtml(errorMessage) +
          " " +
          copy("Public program details remain available below.") +
          "</div>";
      } else if (!isLoggedIn) {
        authBanner.innerHTML =
          '<div class="weletic-landing-guest-actions"><a href="' +
          escapeHtml(registerUrl) +
          '" class="weletic-btn-hero-primary">' +
          copy("Join Now & Earn Points") +
          '</a><a href="' +
          escapeHtml(loginUrl) +
          '" class="weletic-btn-hero-secondary">' +
          copy("Already a Member? Sign In") +
          "</a></div>";
      }
    }

    function renderSections(program, customer) {
      if (destroyed) return;
      if (!contentContainer) return;
      if (!isProgramActive(program)) {
        renderProgramPaused();
        return;
      }
      var html = "";
      var memberView = shared.customerView(customer);
      var canParticipate = shared.customerCanParticipate(
        customer,
        isProgramActive(program),
      );
      var pointNameSingular =
        customer?.program?.pointNameSingular ||
        program?.program?.pointNameSingular ||
        translate("Point");
      var pointNamePlural =
        customer?.program?.pointNamePlural ||
        program?.program?.pointNamePlural ||
        translate("Points");

      // Section 1: Ways to Earn
      if (showEarn) {
        var earnRules = program?.earningRules || [];

        html += '<div style="margin-bottom:56px;">';
        html +=
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">' +
          copy("Ways to Earn Points") +
          "</h2>";
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">' +
          copy("Accumulate points every time you interact with our store.") +
          "</p>";
        html +=
          '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;">';
        earnRules.forEach(function (rule) {
          html +=
            '  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">';
          html +=
            '    <div style="font-size:24px;margin-bottom:12px;">✨</div>';
          html +=
            '    <h3 style="font-size:16px;font-weight:700;color:#111827;margin:0 0 6px;">' +
            escapeHtml(rule.name) +
            "</h3>";
          html +=
            '    <p style="font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.4;">' +
            escapeHtml(
              rule.description ||
                translate("Earn rewards on qualifying activity."),
            ) +
            "</p>";
          html +=
            '    <span style="display:inline-block;font-size:12px;font-weight:700;color:#059669;background:#ecfdf5;padding:4px 10px;border-radius:6px;">' +
            escapeHtml(
              shared.formatEarningValue(
                rule,
                pointNameSingular,
                pointNamePlural,
                {
                  pointsPerCurrencyUnit:
                    program?.program?.pointsPerCurrencyUnit,
                  currency: program?.currency || currency,
                  locale: locale,
                  translate: translate,
                },
              ),
            ) +
            "</span>";
          html += "  </div>";
        });
        html += "  </div>";
        html += "</div>";
      }

      // Section 2: VIP Tiers
      if (showTiers) {
        var tiers = program?.tiers || [];

        html += '<div style="margin-bottom:56px;">';
        html +=
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">' +
          copy("VIP Tier Milestones") +
          "</h2>";
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">' +
          copy(
            "Unlock higher points earning rates and premium benefits as you level up.",
          ) +
          "</p>";
        html +=
          '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;">';
        tiers.forEach(function (tier) {
          html +=
            '  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">';
          html +=
            '    <div style="font-size:24px;margin-bottom:12px;">👑</div>';
          html +=
            '    <h3 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 4px;">' +
            escapeHtml(tier.name) +
            "</h3>";
          html +=
            '    <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">' +
            escapeHtml(formatTierRequirement(program, tier)) +
            "</div>";
          html +=
            '    <div style="font-size:14px;font-weight:700;color:' +
            primaryColor +
            ';margin-bottom:16px;">' +
            copy("{multiplier}x Points Multiplier", {
              multiplier: Number(
                tier.pointsMultiplier ?? tier.multiplier ?? 1.0,
              ).toLocaleString(locale, { maximumFractionDigits: 4 }),
            }) +
            "</div>";
          html +=
            '    <ul style="padding-left:18px;margin:0;font-size:12px;color:#4b5563;line-height:1.6;">';
          if (Array.isArray(tier.perks)) {
            tier.perks.forEach(function (p) {
              html += "<li>" + escapeHtml(p) + "</li>";
            });
          }
          html += "    </ul>";
          html += "  </div>";
        });
        html += "  </div>";
        html += "</div>";
      }

      // Section 3: Ways to Redeem
      if (showRedeem) {
        var rewards = (program?.rewards || []).filter(
          shared.isOnlineStoreReward,
        );
        var rewardCurrency = program?.currency || currency;

        html += '<div style="margin-bottom:56px;">';
        html +=
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">' +
          copy("Ways to Redeem") +
          "</h2>";
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">' +
          copy("Exchange your points for available online rewards.") +
          "</p>";
        html +=
          '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;">';
        rewards.forEach(function (rew) {
          var rewardType = translate(shared.rewardTypeLabel(rew.rewardType));
          var rewardValue = shared.formatRewardValue(rew, rewardCurrency, {
            locale: locale,
            translate: translate,
          });
          var rewardSummary =
            rewardType === rewardValue
              ? rewardType
              : rewardType + " · " + rewardValue;
          var minimumPoints =
            rew.exchangeType === "incremental"
              ? rew.minPointsCost || rew.pointsCost
              : rew.pointsCost;
          html +=
            '  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05);">';
          html += '    <div style="font-size:24px;margin-bottom:8px;">🎁</div>';
          html +=
            '    <h3 style="font-size:16px;font-weight:700;color:#111827;margin:0 0 6px;">' +
            escapeHtml(rew.name) +
            "</h3>";
          html +=
            '    <p style="font-size:12px;color:#4b5563;margin:0 0 8px;">' +
            escapeHtml(rewardSummary) +
            "</p>";
          if (rew.description) {
            html +=
              '    <p style="font-size:12px;color:#6b7280;margin:0 0 8px;">' +
              escapeHtml(rew.description) +
              "</p>";
          }
          html +=
            '    <p style="font-size:14px;font-weight:700;color:#7c3aed;margin:0;">' +
            escapeHtml(
              rew.exchangeType === "incremental"
                ? translate("From {points}", {
                    points: shared.formatPoints(
                      minimumPoints,
                      pointNameSingular,
                      pointNamePlural,
                      locale,
                    ),
                  })
                : shared.formatPoints(
                    minimumPoints,
                    pointNameSingular,
                    pointNamePlural,
                    locale,
                  ),
            ) +
            "</p>";
          html += "  </div>";
        });
        html += "  </div>";
        html += "</div>";
      }

      // Section 4: Referrals
      var referralOffer = activeReferralOffer(program);
      if (showReferrals && referralOffer) {
        var refLink = memberView?.referralShareUrl || null;
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
          '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:24px;padding:40px;text-align:center;margin-bottom:56px;">';
        html +=
          '  <h2 style="font-size:24px;font-weight:700;color:#111827;margin-bottom:8px;">' +
          copy("Refer Your Friends") +
          "</h2>";
        html +=
          '  <p style="font-size:14px;color:#4b5563;max-width:500px;margin:0 auto 24px;">' +
          copy(
            "Give your friend {friend} on their first qualifying order. Earn {advocate} when that order qualifies.",
            { friend: friendBenefit, advocate: advocateBenefit },
          ) +
          "</p>";
        if (memberView && canParticipate && refLink) {
          html +=
            '  <div class="weletic-landing-referral-link" style="display:inline-block;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:6px 12px;font-family:monospace;font-size:13px;margin-bottom:16px;">' +
            escapeHtml(refLink) +
            "</div>";
          html +=
            '  <div><button type="button" style="padding:10px 24px;background:#111827;color:#fff;border:none;border-radius:9999px;font-size:13px;font-weight:600;cursor:pointer;" id="weletic-landing-copy-ref">' +
            copy("Copy Referral Link") +
            "</button></div>";
        } else if (memberView && !canParticipate) {
          html +=
            '  <p class="weletic-load-error" role="status">' +
            copy(
              "Referrals are unavailable while your loyalty account is not active.",
            ) +
            "</p>";
        } else if (memberView) {
          html +=
            '  <p class="weletic-load-error" role="status">' +
            copy(
              "Your referral link is not available yet. Please try again later.",
            ) +
            "</p>";
        } else if (isLoggedIn) {
          html +=
            '  <p class="weletic-load-error" role="status">' +
            copy("Join rewards before creating a referral link.") +
            "</p>";
        } else {
          html +=
            '  <a href="' +
            escapeHtml(loginUrl) +
            '" style="display:inline-block;padding:10px 24px;background:#111827;color:#fff;border-radius:9999px;text-decoration:none;font-size:13px;font-weight:600;">' +
            copy("Sign In to Get Referral Link") +
            "</a>";
        }
        html += "</div>";
      }

      contentContainer.innerHTML = html;

      var copyBtn = contentContainer.querySelector("#weletic-landing-copy-ref");
      if (copyBtn && refLink) {
        copyBtn.setAttribute("aria-live", "polite");
        copyBtn.addEventListener("click", function () {
          copyText(refLink).then(function (copied) {
            if (destroyed) return;
            copyBtn.textContent = copied
              ? translate("Copied to Clipboard!")
              : translate("Copy unavailable — select manually");
            if (copied) {
              scheduleTimeout(function () {
                copyBtn.textContent = translate("Copy Referral Link");
              }, 2000);
            }
          });
        });
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

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (abortController) abortController.abort();
      timeoutIds.forEach(function (timeoutId) {
        window.clearTimeout(timeoutId);
      });
      timeoutIds = [];
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
    var controller = initLoyaltyLanding(root);
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
