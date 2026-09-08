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

  if (window[RUNTIME_KEY]) {
    window[RUNTIME_KEY].mountAll(document);
    return;
  }

  function initLoyaltyWidget(root) {
    if (!root) return null;
    var shared = window.WeleticLoyaltyShared;
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
    var launcherText = root.getAttribute("data-launcher-text") || "Rewards";
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
        ? shared.formatMinorMoney(amount, currencyCode || currency)
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
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
    }

    function rewardStatusLabel(status) {
      if (status === "available") return "Available";
      if (status === "used") return "Used";
      if (status === "expired") return "Expired";
      return "Cancelled";
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
      if (kind === "gift_card") return "Gift card code";
      if (kind === "store_credit") return "Shopify store credit";
      return "Discount code";
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
            : "Copy unavailable — select manually";
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
    };
    var programRequest = null;
    var customerRequest = null;
    var redemptionIntentKeys = {};
    var activityIntentKeys = {};
    var referralBindCodeInFlight = null;

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
        (position === "bottom_left" ? "weletic-pos-left" : "weletic-pos-right");
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
          new Error("Rewards could not start. Please refresh this page."),
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
      if (!shared) {
        return Promise.reject(
          new Error("Rewards could not start. Please refresh this page."),
        );
      }
      if (state.customer) return Promise.resolve(state.customer);
      if (!customerRequest) {
        customerRequest = shared
          .fetchJson(
            proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
            requestOptions(),
          )
          .then(shared.normalizeCustomer)
          .catch(function (error) {
            customerRequest = null;
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

    function toggleDrawer(open) {
      if (destroyed) return;
      state.isOpen = open;
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
        overlay.classList.remove("weletic-open");
        drawer.classList.remove("weletic-open");
      }
    }

    function fetchProgramData() {
      state.loading = true;
      state.error = null;
      state.programError = null;
      render();

      if (!shared) {
        state.loading = false;
        state.error = "Rewards could not start. Please refresh this page.";
        render();
        return;
      }

      var programPromise = loadProgramMetadata();

      // Customer loyalty summary endpoint: /api/shopify/loyalty/customer (accessed via App Proxy /customer)
      var customerPromise = loadCustomerSummary();

      Promise.allSettled([programPromise, customerPromise])
        .then(function (results) {
          if (destroyed) return;
          var programResult = results[0];
          var customerResult = results[1];
          if (customerResult.status === "fulfilled") {
            state.customer = customerResult.value;
            state.customerError = null;
          } else {
            state.customer = null;
            state.customerError =
              programResult.status === "fulfilled"
                ? "Your member balance is temporarily unavailable. Public program details remain available."
                : "Your member balance is temporarily unavailable.";
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
            state.programError =
              "Program details are temporarily unavailable. Member rewards already issued to your account remain visible.";
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
          state.error = "We could not load your rewards. Please try again.";
          render();
        });
    }

    var programPreload = loadProgramMetadata();
    programPreload.catch(function (error) {
      if (destroyed) return;
      console.warn("[Weletic Loyalty Widget] Program preload failed:", error);
      state.programError =
        "Program details are temporarily unavailable. Member rewards already issued to your account remain visible.";
      launcherBtn.hidden = !isLoggedIn;
    });

    if (isLoggedIn && capturedReferralCode) {
      Promise.all([programPreload, loadCustomerSummary()])
        .then(function (results) {
          if (destroyed) return;
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
      if (state.mutationPending) return;

      state.mutationPending = true;
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
          if (destroyed) return;
          if (data && data.success) {
            delete redemptionIntentKeys[intentId];
            state.lastRedeemedArtifact = {
              artifactKind: rewardArtifactKind(data),
              artifactCode: rewardArtifactCode(data),
            };
            // Refetch customer balance
            return shared
              .fetchJson(
                proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
                requestOptions(),
              )
              .then(shared.normalizeCustomer)
              .then(function (customer) {
                if (destroyed) return;
                if (!customer) {
                  throw new Error("Unable to refresh rewards summary");
                }
                state.customer = customer;
              })
              .catch(function (err) {
                if (destroyed) return;
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
          if (destroyed) return;
          alert(error?.message || "Network error redeeming reward.");
        })
        .finally(function () {
          if (destroyed) return;
          state.mutationPending = false;
          render();
        });
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
              throw new Error(
                payload?.error?.message ||
                  "Unable to complete this earning action.",
              );
            }
            return payload?.data || payload;
          });
        })
        .then(function (result) {
          if (destroyed) return;
          delete activityIntentKeys[rule.id];
          state.activityMessage = result.alreadyCompleted
            ? rule.name + " was already completed for this earning period."
            : "+" + result.pointsAwarded + " points added.";
          return shared
            .fetchJson(
              proxyPrefix + "/customer?shop=" + encodeURIComponent(shop),
              requestOptions(),
            )
            .then(shared.normalizeCustomer)
            .then(function (customer) {
              if (destroyed) return;
              state.customer = customer;
            });
        })
        .catch(function (error) {
          if (destroyed) return;
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
          '">Copy code</button>' +
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
      var shopperFirstName =
        loyaltyData && loyaltyData.shopper && loyaltyData.shopper.firstName
          ? loyaltyData.shopper.firstName
          : "";
      var panelTitle = state.program?.branding?.panelTitle || "Rewards Club";
      var configuredSubtitle = state.program?.branding?.panelWelcomeSubtitle;
      var subtitle =
        typeof configuredSubtitle === "string"
          ? configuredSubtitle
          : "Earn points, level up, and unlock rewards.";
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
        '<button type="button" class="weletic-close-btn" aria-label="Close">&times;</button>';
      var greetingHeader =
        isLoggedIn && shopperFirstName
          ? "Hi, " + escapeHtml(shopperFirstName) + "!"
          : escapeHtml(panelTitle);
      html += '<h3 class="weletic-header-title">' + greetingHeader + "</h3>";
      html +=
        '<p class="weletic-header-subtitle">' + escapeHtml(subtitle) + "</p>";

      if (isMember) {
        html += '<div class="weletic-user-card">';
        html += "  <div>";
        html +=
          '    <div class="weletic-points-val">' +
          formatNumber(points) +
          "</div>";
        html +=
          '    <div class="weletic-points-lbl">Available Points' +
          (pending > 0 ? " (+" + formatNumber(pending) + " pending)" : "") +
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
          '<div class="weletic-drawer-body"><div class="weletic-load-state" role="status"><div class="weletic-spinner"></div><span>Loading your rewards...</span></div></div>';
      } else if (state.error) {
        html +=
          '<div class="weletic-drawer-body"><div class="weletic-load-state weletic-load-error" role="alert"><strong>Rewards are temporarily unavailable.</strong><span>' +
          escapeHtml(state.error) +
          '</span><button type="button" class="weletic-btn-load-retry" id="weletic-widget-retry">Try again</button></div></div>';
      } else {
        // Navigation tabs (if logged in or exploring)
        if (programActive) {
          html += '<div class="weletic-tab-nav">';
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "home" ? "weletic-active" : "") +
            '" data-tab="home">Home</button>';
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "earn" ? "weletic-active" : "") +
            '" data-tab="earn">Earn</button>';
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "redeem" ? "weletic-active" : "") +
            '" data-tab="redeem">Redeem</button>';
          html +=
            '<button type="button" class="weletic-tab-btn ' +
            (state.activeTab === "vip" ? "weletic-active" : "") +
            '" data-tab="vip">VIP</button>';
          if (referralActionsAvailable) {
            html +=
              '<button type="button" class="weletic-tab-btn ' +
              (state.activeTab === "refer" ? "weletic-active" : "") +
              '" data-tab="refer">Refer</button>';
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
        }

        if (isMember && !canParticipate) {
          html +=
            '<div class="weletic-load-error weletic-account-restricted" role="status">Your loyalty account is currently unavailable for earning, redemption, and referrals. Existing wallet rewards and history remain visible.</div>';
        }

        if (state.programError) {
          html +=
            '<div class="weletic-load-error weletic-program-load-error" role="alert">' +
            escapeHtml(state.programError) +
            '<button type="button" class="weletic-btn-load-retry" id="weletic-widget-retry">Try again</button></div>';
        } else if (state.program && !programActive) {
          html +=
            '<div class="weletic-load-error weletic-program-paused" role="status">This rewards program is currently unavailable.</div>';
        }

        if (!isMember && state.activeTab === "home") {
          if (!isLoggedIn && programActive && capturedReferralCode) {
            html += renderFriendClaim();
          }
          if (programActive) {
            html += '<div class="weletic-guest-box">';
            html +=
              '  <h4 class="weletic-guest-title">' +
              (isLoggedIn ? "Join the Rewards Club" : "Become a VIP Member") +
              "</h4>";
            html +=
              '  <p class="weletic-guest-desc">' +
              (isLoggedIn
                ? "Your signed-in account is not enrolled in rewards yet. Join the program before earning or redeeming points."
                : "Join our rewards program to earn points on every purchase and unlock exclusive vouchers.") +
              "</p>";
            if (!isLoggedIn) {
              html +=
                '  <a href="' +
                escapeHtml(registerUrl) +
                '" class="weletic-btn-primary">Create Account & Earn Points</a>';
              html +=
                '  <a href="' +
                escapeHtml(loginUrl) +
                '" class="weletic-btn-secondary">Sign In</a>';
            }
            html += "</div>";
          }
        } else if (state.activeTab === "home") {
          if (state.lastRedeemedArtifact) {
            var redeemedKind = state.lastRedeemedArtifact.artifactKind;
            var redeemedCode = state.lastRedeemedArtifact.artifactCode;
            html +=
              '<div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px;border-radius:12px;margin-bottom:12px;text-align:center;">';
            html +=
              '  <div style="font-size:11px;color:#166534;font-weight:600;">Reward Redeemed!</div>';
            if (redeemedKind === "store_credit") {
              html +=
                '  <div style="font-size:12px;color:#166534;margin-top:4px;">Store credit was added to your Shopify customer balance.</div>';
            } else if (redeemedCode) {
              html +=
                '  <div style="font-size:16px;font-weight:800;font-family:monospace;color:#15803d;margin:4px 0;">' +
                escapeHtml(redeemedCode) +
                "</div>";
              html +=
                '  <div style="font-size:10px;color:#166534;">' +
                (redeemedKind === "gift_card"
                  ? "Use this gift card at checkout"
                  : "Use this discount code at checkout") +
                "</div>";
            }
            html += "</div>";
          }

          if (!state.customerError) {
            html +=
              '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">Your Rewards</div>';
            if (availableWallet.length === 0) {
              html +=
                '<div class="weletic-wallet-empty">You have no available coupons.</div>';
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
                '<div class="weletic-wallet-status weletic-wallet-available">Available</div>';
              html += "</div>";
              html +=
                '<div class="weletic-card-desc">' +
                escapeHtml(rewardArtifactLabel(reward)) +
                "</div>";
              html +=
                '<div class="weletic-wallet-code">' +
                (artifactKind === "store_credit"
                  ? "Added to your customer balance"
                  : escapeHtml(artifactCode || "Available in your account")) +
                "</div>";
              html +=
                '<div class="weletic-card-desc">' +
                formatNumber(reward.pointsSpent) +
                " points" +
                (expiryDate ? " · Expires " + escapeHtml(expiryDate) : "") +
                "</div>";
              if (canParticipate && (artifactCode || reward.applyUrl)) {
                html += '<div class="weletic-wallet-actions">';
                if (artifactCode) {
                  html +=
                    '<button type="button" class="weletic-btn-redeem" data-copy-code="' +
                    escapeHtml(artifactCode) +
                    '">Copy code</button>';
                }
                if (reward.applyUrl) {
                  html +=
                    '<a class="weletic-wallet-apply" href="' +
                    escapeHtml(reward.applyUrl) +
                    '" target="_blank" rel="noopener">Use reward</a>';
                }
                html += "</div>";
              }
              html += "</div>";
            });

            if (rewardHistory.length > 0) {
              html +=
                '<div style="font-size:12px;font-weight:700;margin:14px 0 8px;color:#111827;">Reward History</div>';
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
                    ? " · Order " + escapeHtml(reward.orderName)
                    : "") +
                  "</div>";
                html += "</div>";
              });
            }
          }

          if (programActive) {
            html +=
              '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">Quick Rewards</div>';
            rewardsList.slice(0, 2).forEach(function (rew) {
              var rewardValue = shared.formatRewardValue(
                rew,
                state.program?.currency || currency,
              );
              var rewardType = shared.rewardTypeLabel(rew.rewardType);
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
                (isIncremental ? "From " : "") +
                formatNumber(minimumPoints) +
                " points</div>";
              if (isIncremental) {
                html +=
                  '    <input class="weletic-reward-points-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="Points to redeem" data-reward-points data-minimum-points="' +
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
                (state.mutationPending || !canRedeem ? "disabled" : "") +
                ' data-redeem-id="' +
                escapeHtml(rew.id) +
                '">' +
                (state.mutationPending
                  ? "Redeeming…"
                  : canRedeem
                    ? "Redeem"
                    : !canParticipate && isMember
                      ? "Account unavailable"
                      : state.customerError
                        ? "Balance unavailable"
                        : !isMember
                          ? "Members only"
                          : "Need more pts") +
                "</button>";
              html += "</div>";
            });
          }
        } else if (state.activeTab === "earn") {
          html +=
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">Ways to Earn Points</div>';
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
                    (isMember ? "Account unavailable" : "Members only") +
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
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">Redeem Points for Rewards</div>';
          rewardsList.forEach(function (rew) {
            var rewardValue = shared.formatRewardValue(
              rew,
              state.program?.currency || currency,
            );
            var rewardType = shared.rewardTypeLabel(rew.rewardType);
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
              (isIncremental ? "From " : "") +
              formatNumber(minimumPoints) +
              " points</div>";
            if (isIncremental) {
              html +=
                '    <input class="weletic-reward-points-input" type="text" inputmode="numeric" pattern="[0-9]*" aria-label="Points to redeem" data-reward-points data-minimum-points="' +
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
              (state.mutationPending || !canRedeem ? "disabled" : "") +
              ' data-redeem-id="' +
              escapeHtml(rew.id) +
              '">' +
              (state.mutationPending
                ? "Redeeming…"
                : canRedeem
                  ? "Redeem"
                  : !canParticipate && isMember
                    ? "Account unavailable"
                    : state.customerError
                      ? "Balance unavailable"
                      : !isMember
                        ? "Members only"
                        : "Need pts") +
              "</button>";
            html += "</div>";
          });
        } else if (state.activeTab === "vip") {
          html +=
            '<div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;">VIP Tier Benefits</div>';
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

      var tabButtons = drawer.querySelectorAll(".weletic-tab-btn");
      tabButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.activeTab = btn.getAttribute("data-tab");
          render();
        });
      });

      var redeemButtons = drawer.querySelectorAll("[data-redeem-id]");
      redeemButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
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
              alert("Choose a valid points amount within the reward limits.");
              return;
            }
          }
          redeemReward(rewId, pointsRequested);
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
        if (code) bindCopyButton(btn, code, "Copied!", "Copy code");
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
      return shared ? shared.formatInteger(num) : Number(num).toLocaleString();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (abortController) abortController.abort();
      timeoutIds.forEach(function (timeoutId) {
        window.clearTimeout(timeoutId);
      });
      timeoutIds = [];
      launcherBtn.removeEventListener("click", handleLauncherClick);
      overlay.removeEventListener("click", handleOverlayClick);
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
