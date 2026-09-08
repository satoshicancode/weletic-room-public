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

  if (window[RUNTIME_KEY]) {
    window[RUNTIME_KEY].mountAll(document);
    return;
  }

  function initLoyaltyLanding(root) {
    if (!root) return null;
    var shared = window.WeleticLoyaltyShared;
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
          '<div class="weletic-load-state weletic-load-error" role="alert">Rewards could not start. Please refresh this page.</div>';
      }
      return;
    }

    function formatMinorMoney(amount, currencyCode) {
      return shared.formatMinorMoney(amount, currencyCode || currency);
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
      );
      var spendRequirement = formatMinorMoney(
        tier.minSpendThreshold || 0,
        program?.currency,
      );

      if (milestoneMode === "points_earned") {
        return "Points requirement: " + pointsRequirement;
      }
      if (milestoneMode === "both") {
        return "Spend: " + spendRequirement + " • Points: " + pointsRequirement;
      }
      return "Spend requirement: " + spendRequirement;
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
          '<div class="weletic-landing-user-badge" role="status"><span class="weletic-spinner-sm"></span> Loading your member rewards balance...</div>';
      }
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-loading-placeholder" role="status"><div class="weletic-spinner"></div><p>Loading loyalty program details...</p></div>';
      }
    }

    function renderProgramLoadError(customer, customerError) {
      if (destroyed) return;
      renderAuthBanner(customer, customerError);
      if (contentContainer) {
        contentContainer.innerHTML =
          '<div class="weletic-load-state weletic-load-error" role="alert"><strong>We could not load program details.</strong><span>Your member balance and issued rewards are unaffected. Please try again.</span><button type="button" class="weletic-btn-load-retry" id="weletic-landing-retry">Try again</button></div>';
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
          '<div class="weletic-load-state weletic-load-error" role="status"><strong>This rewards program is currently unavailable.</strong><span>Please check back later.</span></div>';
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
              ? "Your rewards balance is temporarily unavailable."
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
            "Your rewards balance is temporarily unavailable.",
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
          '<div style="display:inline-flex;align-items:center;gap:12px;background:#f3f4f6;padding:10px 20px;border-radius:9999px;font-size:14px;color:#111827;">' +
          '  <span>Available Balance: <strong style="color:' +
          primaryColor +
          ';">' +
          escapeHtml(
            shared.formatPoints(
              view.pointsBalance,
              view.pointNameSingular,
              view.pointNamePlural,
            ),
          ) +
          "</strong></span>" +
          "  <span>•</span>" +
          "  <span>VIP Tier: <strong>" +
          escapeHtml(view.tierName) +
          "</strong></span>" +
          "</div>" +
          (!canParticipate
            ? '<div class="weletic-load-error" role="status">Your loyalty account is currently unavailable for earning, redemption, and referrals.</div>'
            : "");
      } else if (isLoggedIn && customer?.isEnrolled === false) {
        authBanner.innerHTML =
          '<div class="weletic-landing-user-badge" role="status">Your signed-in account is not enrolled in rewards yet.</div>';
      } else if (isLoggedIn && errorMessage) {
        authBanner.innerHTML =
          '<div class="weletic-load-error" role="alert">' +
          escapeHtml(errorMessage) +
          " Public program details remain available below.</div>";
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
        "Point";
      var pointNamePlural =
        customer?.program?.pointNamePlural ||
        program?.program?.pointNamePlural ||
        "Points";

      // Section 1: Ways to Earn
      if (showEarn) {
        var earnRules = program?.earningRules || [];

        html += '<div style="margin-bottom:56px;">';
        html +=
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">Ways to Earn Points</h2>';
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">Accumulate points every time you interact with our store.</p>';
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
              rule.description || "Earn rewards on qualifying activity.",
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
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">VIP Tier Milestones</h2>';
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">Unlock higher points earning rates and premium benefits as you level up.</p>';
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
            Number(tier.pointsMultiplier ?? tier.multiplier ?? 1.0) +
            "x Points Multiplier</div>";
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
          '  <h2 style="font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;color:#111827;">Ways to Redeem</h2>';
        html +=
          '  <p style="font-size:14px;color:#6b7280;text-align:center;margin-bottom:32px;">Exchange your points for available online rewards.</p>';
        html +=
          '  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;">';
        rewards.forEach(function (rew) {
          var rewardType = shared.rewardTypeLabel(rew.rewardType);
          var rewardValue = shared.formatRewardValue(rew, rewardCurrency);
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
            (rew.exchangeType === "incremental" ? "From " : "") +
            escapeHtml(
              shared.formatPoints(
                minimumPoints,
                pointNameSingular,
                pointNamePlural,
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
          '  <h2 style="font-size:24px;font-weight:700;color:#111827;margin-bottom:8px;">Refer Your Friends</h2>';
        html +=
          '  <p style="font-size:14px;color:#4b5563;max-width:500px;margin:0 auto 24px;">Give your friend ' +
          escapeHtml(friendBenefit) +
          " on their first qualifying order. Earn " +
          escapeHtml(advocateBenefit) +
          " when that order qualifies.</p>";
        if (memberView && canParticipate && refLink) {
          html +=
            '  <div style="display:inline-flex;align-items:center;background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:6px 12px;font-family:monospace;font-size:13px;margin-bottom:16px;">' +
            escapeHtml(refLink) +
            "</div>";
          html +=
            '  <div><button type="button" style="padding:10px 24px;background:#111827;color:#fff;border:none;border-radius:9999px;font-size:13px;font-weight:600;cursor:pointer;" id="weletic-landing-copy-ref">Copy Referral Link</button></div>';
        } else if (memberView && !canParticipate) {
          html +=
            '  <p class="weletic-load-error" role="status">Referrals are unavailable while your loyalty account is not active.</p>';
        } else if (memberView) {
          html +=
            '  <p class="weletic-load-error" role="status">Your referral link is not available yet. Please try again later.</p>';
        } else if (isLoggedIn) {
          html +=
            '  <p class="weletic-load-error" role="status">Join rewards before creating a referral link.</p>';
        } else {
          html +=
            '  <a href="' +
            escapeHtml(loginUrl) +
            '" style="display:inline-block;padding:10px 24px;background:#111827;color:#fff;border-radius:9999px;text-decoration:none;font-size:13px;font-weight:600;">Sign In to Get Referral Link</a>';
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
              ? "Copied to Clipboard!"
              : "Copy unavailable — select manually";
            if (copied) {
              scheduleTimeout(function () {
                copyBtn.textContent = "Copy Referral Link";
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
