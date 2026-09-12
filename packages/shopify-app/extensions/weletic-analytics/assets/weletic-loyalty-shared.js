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

  function formatInteger(value, locale) {
    var amount = parseIntegerValue(value);
    if (amount === null) return "0";
    try {
      return amount.toLocaleString(locale);
    } catch (_error) {
      var sign = amount < BigInt(0) ? "-" : "";
      var digits = (amount < BigInt(0) ? -amount : amount).toString();
      return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }

  function formatNumber(value) {
    return formatInteger(value);
  }

  function formatPoints(value, singular, plural, locale) {
    var amount = parseIntegerValue(value);
    var name = amount === BigInt(1) ? singular || "Point" : plural || "Points";
    return formatInteger(amount, locale) + " " + name;
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

  function formatCurrencyUnit(currency, locale) {
    var currencyCode = currency || "USD";
    try {
      return new Intl.NumberFormat(locale, {
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
        return translatedValue(context, "{points} per {amount}", {
          points: effectiveRate + " " + rateName,
          amount: formatCurrencyUnit(context.currency, context.locale),
        });
      }

      var numericMultiplier = Number(multiplier);
      return (
        (Number.isFinite(numericMultiplier)
          ? numericMultiplier
          : 1
        ).toLocaleString(context?.locale) +
        "\u00d7 " +
        String(plural || "Points").toLowerCase()
      );
    }
    return (
      "+" +
      formatPoints(rule?.fixedPoints || 0, singular, plural, context?.locale)
    );
  }

  function formatMinorMoney(value, currency, locale) {
    var amount = parseIntegerValue(value);
    var currencyCode = currency || "USD";
    try {
      var formatter = new Intl.NumberFormat(locale, {
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

  function translatedValue(context, message, values) {
    if (typeof context?.translate === "function")
      return context.translate(message, values);
    return message.replace(/\{(\w+)\}/g, function (match, key) {
      return values && own(values, key) ? String(values[key]) : match;
    });
  }

  function formatRewardValue(reward, currency, context) {
    if (!reward) return translatedValue(context, "Reward");
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
        return translatedValue(context, "{amount} off", {
          amount: formatMinorMoney(discountValue, currency, context?.locale),
        });
      case "percentage_off":
        return translatedValue(context, "{amount} off", {
          amount: formatDecimal(reward.discountValue) + "%",
        });
      case "free_shipping":
        return translatedValue(context, "Free shipping");
      case "free_product":
        return translatedValue(context, "Free product");
      case "gift_card":
        return translatedValue(context, "{amount} gift card", {
          amount: formatMinorMoney(
            reward.discountValue,
            currency,
            context?.locale,
          ),
        });
      case "store_credit":
        return translatedValue(context, "{amount} store credit", {
          amount: formatMinorMoney(
            reward.discountValue,
            currency,
            context?.locale,
          ),
        });
      default:
        return translatedValue(context, rewardTypeLabel(reward.rewardType));
    }
  }

  function isOnlineStoreReward(reward) {
    return (
      Boolean(reward) &&
      (reward.salesChannel === "online_store" || reward.salesChannel === "both")
    );
  }

  // Display selection only. `eligible` must come from the current shopper-safe
  // projection after capability/cart restrictions; this never authorizes a
  // redemption. Impression/dismissal coordination belongs to the caller.
  // Read-only presentation input. Retain Shopify's integer amount unit explicitly;
  // it is not interchangeable with our ledger minor units without currency proof.
  function normalizeLoyaltyNudgeCart(cart) {
    function amount(value) {
      var parsed = parseIntegerValue(value);
      return parsed !== null && parsed >= BigInt(0) ? parsed.toString() : null;
    }
    function id(value) {
      var parsed = amount(value);
      return parsed !== null && parsed !== "0" && parsed.length <= 20
        ? parsed
        : null;
    }
    if (
      !cart ||
      typeof cart !== "object" ||
      Array.isArray(cart) ||
      typeof cart.currency !== "string" ||
      !/^[A-Z]{3}$/.test(cart.currency) ||
      !Array.isArray(cart.items) ||
      cart.items.length > 250 ||
      !Array.isArray(cart.cart_level_discount_applications) ||
      !Number.isSafeInteger(cart.item_count) ||
      cart.item_count < 0
    )
      return null;
    var total = amount(cart.total_price);
    var subtotal = amount(cart.items_subtotal_price);
    var discount = amount(cart.total_discount);
    if (total === null || subtotal === null || discount === null) return null;
    var count = BigInt(0);
    var lines = [];
    for (var index = 0; index < cart.items.length; index++) {
      var item = cart.items[index];
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 ||
        typeof item.requires_shipping !== "boolean" ||
        typeof item.gift_card !== "boolean"
      )
        return null;
      if (own(item, "remote") && typeof item.remote !== "boolean") return null;
      var productId = id(item.product_id);
      var variantId = id(item.variant_id);
      var lineAmount = amount(item.final_line_price);
      if (productId === null || variantId === null || lineAmount === null)
        return null;
      var purchaseKind = "one_time";
      if (
        item.selling_plan_allocation !== null &&
        item.selling_plan_allocation !== undefined
      ) {
        var allocation = item.selling_plan_allocation;
        if (
          typeof allocation !== "object" ||
          Array.isArray(allocation) ||
          !allocation.selling_plan ||
          id(allocation.selling_plan.id) === null
        )
          return null;
        purchaseKind = "subscription";
      }
      count += BigInt(item.quantity);
      lines.push({
        productId: productId,
        variantId: variantId,
        quantity: item.quantity,
        amount: lineAmount,
        purchaseKind: purchaseKind,
        requiresShipping: item.requires_shipping,
        giftCard: item.gift_card,
        remote: item.remote === true,
      });
    }
    if (count !== BigInt(cart.item_count)) return null;
    return {
      amountUnit: "shopify_cart_integer",
      currency: cart.currency,
      total: total,
      subtotal: subtotal,
      discount: discount,
      hasAppliedDiscount:
        BigInt(discount) > BigInt(0) ||
        cart.cart_level_discount_applications.length > 0,
      lines: lines,
    };
  }

  async function loadLoyaltyNudgeCart(localeRoot, signal) {
    // Relative same-origin routes only: no proxy, third-party origin or writes.
    if (
      typeof localeRoot !== "string" ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(localeRoot) ||
      (signal && signal.aborted)
    )
      return null;
    try {
      var payload = await fetchJson(localeRoot + "cart.js", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: signal,
      });
      return signal && signal.aborted
        ? null
        : normalizeLoyaltyNudgeCart(payload);
    } catch (_) {
      return null;
    }
  }

  function loyaltyNudgeMinimumSatisfied(cart, terms, collectionsByProduct) {
    if (
      !cart ||
      !terms ||
      cart.amountUnit !== "shopify_cart_integer" ||
      cart.currency !== terms.currency ||
      typeof terms.currency !== "string" ||
      !/^[A-Z]{3}$/.test(terms.currency) ||
      !Number.isInteger(terms.currencyMinorUnits) ||
      ![0, 2].includes(terms.currencyMinorUnits) ||
      !Array.isArray(cart.lines)
    )
      return false;
    var subtotal = BigInt(0);
    var hasMatchedLine = false;
    // A shipping reward still needs a shippable item, but its minimum includes
    // all otherwise matching merchandise, including non-shipping items.
    if (!loyaltyNudgeRewardMatchesCartLines(cart, terms, collectionsByProduct))
      return false;
    var subtotalTerms =
      terms.rewardType === "free_shipping"
        ? Object.assign({}, terms, { rewardType: "amount_off" })
        : terms;
    for (var index = 0; index < cart.lines.length; index++) {
      var line = cart.lines[index];
      if (
        !loyaltyNudgeRewardMatchesCartLines(
          { lines: [line] },
          subtotalTerms,
          collectionsByProduct,
        )
      )
        continue;
      var amount = parseIntegerValue(line.amount);
      if (amount === null || amount < BigInt(0)) return false;
      subtotal += amount;
      hasMatchedLine = true;
    }
    var minimum =
      terms.minOrderAmount === null
        ? BigInt(0)
        : parseIntegerValue(terms.minOrderAmount);
    if (!hasMatchedLine || minimum === null || minimum < BigInt(0))
      return false;
    // Shopify cart amounts append two decimal places for zero-decimal currencies.
    // The exponent is supplied by the same backend that defines ledger minor units.
    // Other precision mappings stay unavailable until their wire units are proved.
    var scale =
      BigInt(10) **
      BigInt(Math.max(2, terms.currencyMinorUnits) - terms.currencyMinorUnits);
    return subtotal >= minimum * scale;
  }

  // Scope only, not permission to issue/apply a reward. Collection membership
  // must be current caller-proven catalog data; absence must not mean membership.
  function loyaltyNudgeRewardMatchesCartLines(
    cart,
    terms,
    collectionsByProduct,
  ) {
    if (
      !cart ||
      !Array.isArray(cart.lines) ||
      !terms ||
      !terms.purchasePolicy ||
      !["one_time", "subscription", "both"].includes(
        terms.purchasePolicy.purchaseType,
      ) ||
      !["entire_order", "specific_items"].includes(terms.appliesToResource)
    )
      return false;
    function resourceId(value, kind) {
      if (typeof value !== "string") return null;
      var prefix = "gid://shopify/" + kind + "/";
      var raw =
        value.indexOf(prefix) === 0 ? value.slice(prefix.length) : value;
      return /^[1-9][0-9]{0,19}$/.test(raw) ? raw : null;
    }
    function ids(values, kind) {
      if (!Array.isArray(values) || values.length > 250) return null;
      var normalized = values.map(function (value) {
        return resourceId(value, kind);
      });
      return normalized.some(function (value) {
        return value === null;
      })
        ? null
        : normalized;
    }
    var products = ids(terms.entitledProductIds, "Product");
    var variants = ids(terms.entitledVariantIds, "ProductVariant");
    var collections = ids(terms.entitledCollectionIds, "Collection");
    if (!products || !variants || !collections) return false;
    var specific = terms.appliesToResource === "specific_items";
    var targetCount = products.length + variants.length + collections.length;
    if (
      (!specific && targetCount > 0) ||
      (specific && targetCount === 0) ||
      (collections.length > 0 && products.length + variants.length > 0)
    )
      return false;
    return cart.lines.some(function (line) {
      if (
        !line ||
        line.remote !== false ||
        line.giftCard !== false ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        !["one_time", "subscription"].includes(line.purchaseKind) ||
        (terms.purchasePolicy.purchaseType !== "both" &&
          terms.purchasePolicy.purchaseType !== line.purchaseKind)
      )
        return false;
      if (
        terms.rewardType === "free_shipping" &&
        line.requiresShipping !== true
      )
        return false;
      var product = resourceId(line.productId, "Product");
      var variant = resourceId(line.variantId, "ProductVariant");
      if (!product || !variant) return false;
      if (!specific || products.includes(product) || variants.includes(variant))
        return true;
      var membership =
        collectionsByProduct && own(collectionsByProduct, product)
          ? ids(collectionsByProduct[product], "Collection")
          : null;
      return Boolean(
        membership &&
          membership.some(function (id) {
            return collections.includes(id);
          }),
      );
    });
  }

  // Catalog-only presentation hint. This never authorizes redemption or applies
  // a discount, and must not be used for immutable issued-wallet terms.
  function loyaltyCatalogNudgeEligible(
    cart,
    reward,
    program,
    collectionsByProduct,
  ) {
    var cost = reward && parseIntegerValue(reward.pointsCost);
    if (
      !reward ||
      reward.canRedeem !== true ||
      cost === null ||
      cost <= BigInt(0) ||
      !program ||
      program.isActive !== true
    )
      return false;
    return loyaltyDiscountMatchesNudgeCart(
      cart,
      Object.assign({}, reward, {
        currency: program.currency,
        currencyMinorUnits: program.currencyMinorUnits,
      }),
      collectionsByProduct,
    );
  }

  function loyaltyDiscountMatchesNudgeCart(cart, reward, collectionsByProduct) {
    if (
      !cart ||
      cart.hasAppliedDiscount !== false ||
      !reward ||
      reward.exchangeType !== "fixed" ||
      !isOnlineStoreReward(reward) ||
      ![
        "amount_off",
        "percentage_off",
        "free_shipping",
        "free_product",
      ].includes(reward.rewardType)
    )
      return false;
    var policy = reward.purchasePolicy;
    if (
      !policy ||
      !["one_time", "subscription", "both"].includes(policy.purchaseType) ||
      !["first_payment", "first_n_payments", "every_payment"].includes(
        policy.subscriptionCadence,
      ) ||
      (policy.purchaseType === "one_time" &&
        policy.subscriptionCadence !== "first_payment") ||
      (policy.subscriptionCadence === "first_n_payments"
        ? !Number.isInteger(policy.subscriptionPaymentLimit) ||
          policy.subscriptionPaymentLimit < 2 ||
          policy.subscriptionPaymentLimit > 1000
        : policy.subscriptionPaymentLimit !== null)
    )
      return false;
    // All supported native cadences permit the initial cart purchase. A selling
    // plan here does not establish any subsequent order's renewal sequence.
    return loyaltyNudgeMinimumSatisfied(cart, reward, collectionsByProduct);
  }

  function loyaltyWalletNudgeEligible(
    cart,
    reward,
    nowMs,
    collectionsByProduct,
  ) {
    if (
      !reward ||
      reward.termsSource !== "issuance_snapshot" ||
      reward.status !== "available" ||
      reward.artifactKind !== "discount_code" ||
      typeof reward.applyUrl !== "string" ||
      !reward.applyUrl ||
      !Number.isFinite(nowMs)
    )
      return false;
    var terms = reward.termsSnapshot;
    if (
      !terms ||
      terms.version !== 1 ||
      terms.exchangeType !== "fixed" ||
      terms.rewardType !== reward.rewardType ||
      terms.salesChannel !== reward.salesChannel
    )
      return false;
    var startsAt =
      typeof terms.startsAt === "string" ? Date.parse(terms.startsAt) : NaN;
    if (!Number.isFinite(startsAt) || startsAt > nowMs) return false;
    var issuedAt =
      typeof reward.issuedAt === "string" ? Date.parse(reward.issuedAt) : NaN;
    if (!Number.isFinite(issuedAt) || issuedAt > nowMs) return false;
    if (reward.expiresAt !== null) {
      var expiresAt =
        typeof reward.expiresAt === "string"
          ? Date.parse(reward.expiresAt)
          : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
    }
    return loyaltyDiscountMatchesNudgeCart(cart, terms, collectionsByProduct);
  }

  function selectLoyaltyNudge(context) {
    if (
      !context ||
      context.stateFresh !== true ||
      context.programActive !== true ||
      context.launcherVisible !== true ||
      !context.enabled
    )
      return null;
    if (context.authenticated === false) {
      return context.firstVisit === true && context.enabled.signup === true
        ? "signup"
        : null;
    }
    if (
      context.authenticated !== true ||
      context.cartPage !== true ||
      context.cartHasItems !== true ||
      typeof context.hasAppliedDiscount !== "boolean" ||
      !Number.isFinite(context.nowMs)
    )
      return null;
    function supported(reward) {
      return (
        reward &&
        reward.eligible === true &&
        reward.exchangeType === "fixed" &&
        isOnlineStoreReward(reward) &&
        [
          "amount_off",
          "percentage_off",
          "free_shipping",
          "free_product",
        ].includes(reward.rewardType)
      );
    }
    var wallet = Array.isArray(context.wallet) ? context.wallet : [];
    if (
      context.enabled.reward_usage === true &&
      !context.hasAppliedDiscount &&
      wallet.some(function (reward) {
        if (!supported(reward) || reward.status !== "available") return false;
        if (reward.expiresAt === null) return true;
        if (typeof reward.expiresAt !== "string") return false;
        var expires = Date.parse(reward.expiresAt);
        return Number.isFinite(expires) && expires > context.nowMs;
      })
    )
      return "reward_usage";
    var balance = parseIntegerValue(context.availablePoints);
    if (
      context.enabled.points_spending !== true ||
      balance === null ||
      balance < BigInt(0)
    )
      return null;
    var rewards = Array.isArray(context.rewards) ? context.rewards : [];
    return rewards.some(function (reward) {
      var cost = reward && parseIntegerValue(reward.pointsCost);
      return (
        supported(reward) &&
        cost !== null &&
        cost !== undefined &&
        cost > BigInt(0) &&
        cost <= balance
      );
    })
      ? "points_spending"
      : null;
  }

  // Optional prompts fail closed if storage/coordination is unavailable. This
  // anonymous browser-local receipt is never financial or customer identity data.
  async function claimLoyaltyNudgeImpression(options) {
    var key = "weletic.loyalty.nudges.v1";
    if (
      !options ||
      !["signup", "points_spending", "reward_usage"].includes(options.kind) ||
      !Number.isSafeInteger(options.nowMs) ||
      options.nowMs < 0 ||
      !options.storage ||
      !options.locks ||
      typeof options.locks.request !== "function" ||
      typeof options.isEligible !== "function"
    )
      return false;
    try {
      return await options.locks.request(
        key,
        { mode: "exclusive" },
        function () {
          // Eligibility may have changed while another tab held the lock. Require
          // a synchronous fresh check; a Promise must never count as permission.
          if (options.isEligible() !== true) return false;
          var raw = options.storage.getItem(key);
          var receipt =
            raw === null
              ? { version: 1, signupSeen: false, cartAt: null }
              : JSON.parse(raw);
          if (
            !receipt ||
            Array.isArray(receipt) ||
            Object.keys(receipt).sort().join(",") !==
              "cartAt,signupSeen,version" ||
            receipt.version !== 1 ||
            typeof receipt.signupSeen !== "boolean" ||
            (receipt.cartAt !== null &&
              (!Number.isSafeInteger(receipt.cartAt) || receipt.cartAt < 0))
          )
            return false;
          if (options.kind === "signup") {
            if (receipt.signupSeen) return false;
            receipt.signupSeen = true;
          } else {
            // Future timestamps also suppress prompts after a local clock rollback.
            if (
              receipt.cartAt !== null &&
              options.nowMs - receipt.cartAt < 86400000
            )
              return false;
            receipt.cartAt = options.nowMs;
          }
          var serialized = JSON.stringify(receipt);
          options.storage.setItem(key, serialized);
          // Some privacy modes silently reject writes instead of throwing.
          return options.storage.getItem(key) === serialized;
        },
      );
    } catch (_) {
      return false;
    }
  }

  async function claimLoyaltyFirstVisit(storage, locks) {
    try {
      if (!storage || !locks || typeof locks.request !== "function")
        return false;
      return await locks.request(
        "weletic.loyalty.first-visit.v1",
        { mode: "exclusive" },
        function () {
          var key = "weletic.loyalty.first-visit.v1";
          if (storage.getItem(key) !== null) return false;
          storage.setItem(key, "1");
          return storage.getItem(key) === "1";
        },
      );
    } catch (_) {
      return false;
    }
  }

  global.WeleticLoyaltyShared = Object.freeze({
    normalizeLoyaltyNudgeCart: normalizeLoyaltyNudgeCart,
    loadLoyaltyNudgeCart: loadLoyaltyNudgeCart,
    loyaltyNudgeMinimumSatisfied: loyaltyNudgeMinimumSatisfied,
    loyaltyNudgeRewardMatchesCartLines: loyaltyNudgeRewardMatchesCartLines,
    loyaltyCatalogNudgeEligible: loyaltyCatalogNudgeEligible,
    loyaltyWalletNudgeEligible: loyaltyWalletNudgeEligible,
    claimLoyaltyFirstVisit: claimLoyaltyFirstVisit,
    claimLoyaltyNudgeImpression: claimLoyaltyNudgeImpression,
    selectLoyaltyNudge: selectLoyaltyNudge,
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
