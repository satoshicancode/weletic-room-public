/**
 * Shared Shopify Basic loyalty storefront helpers.
 * Keeps API envelope handling and shopper-safe formatting consistent across
 * the floating drawer and the full-page loyalty landing block.
 */
(function (global) {
  "use strict";

  if (global.WeleticLoyaltyShared) return;

  var DEFAULT_TIMEOUT_MS = 12000;

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function responseError(payload, fallbackMessage, status) {
    var message =
      payload && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : fallbackMessage;
    var error = new Error(message);
    error.status = status;
    error.code = payload?.error?.code || "request_failed";
    return error;
  }

  function unwrapPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw responseError(null, "The rewards service returned invalid data.");
    }
    if (payload.error) {
      throw responseError(payload, "Unable to load rewards.");
    }
    return own(payload, "data") ? payload.data : payload;
  }

  function fetchJson(url, init) {
    var requestInit = Object.assign({}, init || {});
    var timeoutMs = Number(requestInit.timeoutMs || DEFAULT_TIMEOUT_MS);
    delete requestInit.timeoutMs;

    var externalSignal = requestInit.signal || null;
    var controller =
      typeof global.AbortController === "function"
        ? new global.AbortController()
        : null;
    var timedOut = false;
    var handleExternalAbort = null;
    if (controller) requestInit.signal = controller.signal;
    if (controller && externalSignal) {
      handleExternalAbort = function () {
        controller.abort();
      };
      if (externalSignal.aborted) {
        handleExternalAbort();
      } else {
        externalSignal.addEventListener("abort", handleExternalAbort, {
          once: true,
        });
      }
    }

    var timeoutId = controller
      ? global.setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

    return global
      .fetch(url, requestInit)
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (payload) {
            if (!response.ok) {
              throw responseError(
                payload,
                "Unable to load rewards right now.",
                response.status,
              );
            }
            return unwrapPayload(payload);
          });
      })
      .catch(function (error) {
        if (error && error.name === "AbortError" && timedOut) {
          throw responseError(
            null,
            "The rewards service took too long to respond.",
          );
        }
        throw error;
      })
      .finally(function () {
        if (timeoutId !== null) global.clearTimeout(timeoutId);
        if (externalSignal && handleExternalAbort) {
          externalSignal.removeEventListener("abort", handleExternalAbort);
        }
      });
  }

  function normalizeProgram(payload) {
    var program = unwrapPayload(payload);
    if (!program || typeof program !== "object") {
      throw responseError(null, "The rewards program is unavailable.");
    }

    return Object.assign({}, program, {
      tiers: Array.isArray(program.tiers) ? program.tiers : [],
      earningRules: Array.isArray(program.earningRules)
        ? program.earningRules
        : [],
      rewards: Array.isArray(program.rewards) ? program.rewards : [],
    });
  }

  function normalizeCustomer(payload) {
    var customer = unwrapPayload(payload);
    if (!customer || typeof customer !== "object") {
      throw responseError(null, "Your rewards account is unavailable.");
    }

    var account = customer.account;
    if (!account && customer.isEnrolled === false) {
      account = {
        pointsBalance: customer.pointsBalance ?? "0",
        pendingPoints: customer.pendingPoints ?? "0",
        lifetimePointsEarned: customer.lifetimePointsEarned ?? "0",
      };
    }
    if (!account || account.pointsBalance === undefined) {
      throw responseError(null, "Your rewards balance is unavailable.");
    }

    var tier = customer.tier || null;
    if (tier && !tier.currentTier && tier.name) {
      tier = Object.assign({}, tier, { currentTier: tier });
    }

    return Object.assign({}, customer, {
      account: account,
      tier: tier,
      referral:
        customer.referral && typeof customer.referral === "object"
          ? customer.referral
          : null,
    });
  }

  function customerView(customer) {
    if (!customer || customer.isEnrolled === false || !customer.account) {
      return null;
    }
    return {
      pointsBalance: customer.account.pointsBalance,
      pendingPoints: customer.account.pendingPoints ?? "0",
      tierName: customer.tier?.currentTier?.name || "Member",
      pointNameSingular: customer.program?.pointNameSingular || null,
      pointNamePlural: customer.program?.pointNamePlural || null,
      referralShareUrl: customer.referral?.referralShareUrl || null,
    };
  }

  function customerCanParticipate(customer, programIsActive) {
    return (
      programIsActive === true &&
      customer?.account?.status === "active" &&
      customer.account.canParticipate === true
    );
  }

  function parseIntegerValue(value) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) ? BigInt(value) : null;
    }
    if (typeof value !== "string") return null;

    var normalized = value.trim();
    if (!/^-?\d+(?:\.0+)?$/.test(normalized)) return null;
    try {
      return BigInt(normalized.split(".")[0]);
    } catch (_error) {
      return null;
    }
  }

  function compareIntegerValues(left, right) {
    var leftInteger = parseIntegerValue(left);
    var rightInteger = parseIntegerValue(right);
    if (leftInteger === null || rightInteger === null) return null;
    if (leftInteger < rightInteger) return -1;
    if (leftInteger > rightInteger) return 1;
    return 0;
  }

  function isIntegerAtLeast(value, minimum) {
    var comparison = compareIntegerValues(value, minimum);
    return comparison !== null && comparison >= 0;
  }

  function minIntegerValue(left, right) {
    var comparison = compareIntegerValues(left, right);
    if (comparison === null) return null;
    var selected = comparison <= 0 ? left : right;
    return parseIntegerValue(selected).toString();
  }

  function formatInteger(value) {
    var amount = parseIntegerValue(value);
    if (amount === null) return "0";
    try {
      return amount.toLocaleString();
    } catch (_error) {
      var sign = amount < BigInt(0) ? "-" : "";
      var digits = (amount < BigInt(0) ? -amount : amount).toString();
      return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }

  function formatNumber(value) {
    return formatInteger(value);
  }

  function formatPoints(value, singular, plural) {
    var amount = parseIntegerValue(value);
    var name = amount === BigInt(1) ? singular || "Point" : plural || "Points";
    return formatNumber(amount) + " " + name;
  }

  function parseUnsignedDecimal(value) {
    var normalized =
      typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : "";
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;

    var parts = normalized.split(".");
    var fraction = (parts[1] || "").replace(/0+$/, "");
    try {
      return {
        coefficient: BigInt(parts[0] + fraction),
        scale: fraction.length,
      };
    } catch (_error) {
      return null;
    }
  }

  function formatDecimalProduct(left, right) {
    var leftDecimal = parseUnsignedDecimal(left);
    var rightDecimal = parseUnsignedDecimal(right);
    if (!leftDecimal || !rightDecimal) return null;

    var coefficient = leftDecimal.coefficient * rightDecimal.coefficient;
    var scale = leftDecimal.scale + rightDecimal.scale;
    var digits = coefficient.toString();
    if (scale === 0) return digits;
    digits = digits.padStart(scale + 1, "0");
    var integerPart = digits.slice(0, -scale);
    var fractionPart = digits.slice(-scale).replace(/0+$/, "");
    return fractionPart ? integerPart + "." + fractionPart : integerPart;
  }

  function formatDecimal(value) {
    var decimal = parseUnsignedDecimal(value);
    if (!decimal) return "0";

    var digits = decimal.coefficient.toString();
    if (decimal.scale === 0) return digits;
    digits = digits.padStart(decimal.scale + 1, "0");
    return digits.slice(0, -decimal.scale) + "." + digits.slice(-decimal.scale);
  }

  function formatCurrencyUnit(currency) {
    var currencyCode = currency || "USD";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(1);
    } catch (_error) {
      return currencyCode + " 1";
    }
  }

  function formatEarningValue(rule, singular, plural, context) {
    if (rule && rule.triggerCode === "order_paid") {
      var multiplier = rule.multiplier ?? 1;
      var effectiveRate = context
        ? formatDecimalProduct(context.pointsPerCurrencyUnit, multiplier)
        : null;
      if (effectiveRate !== null) {
        var rateName =
          effectiveRate === "1" ? singular || "Point" : plural || "Points";
        return (
          effectiveRate +
          " " +
          rateName +
          " per " +
          formatCurrencyUnit(context.currency)
        );
      }

      var numericMultiplier = Number(multiplier);
      return (
        (Number.isFinite(numericMultiplier)
          ? numericMultiplier
          : 1
        ).toLocaleString() +
        "\u00d7 " +
        String(plural || "Points").toLowerCase()
      );
    }
    return "+" + formatPoints(rule?.fixedPoints || 0, singular, plural);
  }

  function formatMinorMoney(value, currency) {
    var amount = parseIntegerValue(value);
    var currencyCode = currency || "USD";
    try {
      var formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      });
      var fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
      if (amount === null) return formatter.format(0);

      var isNegative = amount < BigInt(0);
      var absoluteAmount = isNegative ? -amount : amount;
      var divisor = BigInt(10) ** BigInt(fractionDigits);
      var whole = absoluteAmount / divisor;
      var fraction = (absoluteAmount % divisor)
        .toString()
        .padStart(fractionDigits, "0");
      var formatted = formatter
        .formatToParts(whole)
        .map(function (part) {
          return part.type === "fraction" ? fraction : part.value;
        })
        .join("");
      return isNegative ? "-" + formatted : formatted;
    } catch (_error) {
      return currencyCode + " " + formatInteger(amount);
    }
  }

  function rewardTypeLabel(rewardType) {
    switch (rewardType) {
      case "amount_off":
        return "Amount off";
      case "percentage_off":
        return "Percentage off";
      case "free_shipping":
        return "Free shipping";
      case "free_product":
        return "Free product";
      case "gift_card":
        return "Gift card";
      case "store_credit":
        return "Store credit";
      default:
        return "Reward";
    }
  }

  function formatRewardValue(reward, currency) {
    if (!reward) return "Reward";
    switch (reward.rewardType) {
      case "amount_off":
        var discountValue = parseIntegerValue(reward.discountValue);
        if (reward.exchangeType === "incremental") {
          var pointsStep = parseIntegerValue(reward.pointsStep);
          var minimumPoints = parseIntegerValue(
            reward.minPointsCost ?? reward.pointsCost,
          );
          if (
            discountValue !== null &&
            pointsStep !== null &&
            pointsStep > BigInt(0) &&
            minimumPoints !== null &&
            minimumPoints > BigInt(0) &&
            minimumPoints % pointsStep === BigInt(0)
          ) {
            discountValue *= minimumPoints / pointsStep;
            var maximumDiscount = parseIntegerValue(reward.maxDiscountValue);
            if (
              maximumDiscount !== null &&
              maximumDiscount > BigInt(0) &&
              discountValue > maximumDiscount
            ) {
              discountValue = maximumDiscount;
            }
          }
        }
        return formatMinorMoney(discountValue, currency) + " off";
      case "percentage_off":
        return formatDecimal(reward.discountValue) + "% off";
      case "free_shipping":
        return "Free shipping";
      case "free_product":
        return "Free product";
      case "gift_card":
        return formatMinorMoney(reward.discountValue, currency) + " gift card";
      case "store_credit":
        return (
          formatMinorMoney(reward.discountValue, currency) + " store credit"
        );
      default:
        return rewardTypeLabel(reward.rewardType);
    }
  }

  function isOnlineStoreReward(reward) {
    return (
      Boolean(reward) &&
      (reward.salesChannel === "online_store" || reward.salesChannel === "both")
    );
  }

  global.WeleticLoyaltyShared = Object.freeze({
    compareIntegerValues: compareIntegerValues,
    customerCanParticipate: customerCanParticipate,
    customerView: customerView,
    fetchJson: fetchJson,
    formatEarningValue: formatEarningValue,
    formatInteger: formatInteger,
    formatMinorMoney: formatMinorMoney,
    formatPoints: formatPoints,
    formatRewardValue: formatRewardValue,
    isIntegerAtLeast: isIntegerAtLeast,
    isOnlineStoreReward: isOnlineStoreReward,
    minIntegerValue: minIntegerValue,
    normalizeCustomer: normalizeCustomer,
    normalizeProgram: normalizeProgram,
    rewardTypeLabel: rewardTypeLabel,
    unwrapPayload: unwrapPayload,
  });
})(window);
