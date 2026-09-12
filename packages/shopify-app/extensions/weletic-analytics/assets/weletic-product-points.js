/**
 * Weletic Product Points Dynamic Preview Controller
 * Recalculates projected points earned reactively on variant selection.
 * Strictly compliant with Zero-PII DOM architecture.
 */
(function () {
  "use strict";

  function initProductPoints() {
    var containers = document.querySelectorAll(
      ".weletic-product-points-container",
    );
    if (!containers || containers.length === 0) return;

    containers.forEach(function (container) {
      var shop =
        container.getAttribute("data-shop") || window.location.hostname;
      var currency = container.getAttribute("data-currency") || "USD";
      var proxyPrefix =
        container.getAttribute("data-proxy-prefix") || "/apps/weletic";
      var pointsNumberEl = container.querySelector(".weletic-points-number");
      if (!pointsNumberEl) return;

      var pointsRate = null;
      var locale =
        container.getAttribute("data-locale") ||
        document.documentElement.lang ||
        "en";

      function integerPrice(value) {
        if (typeof value === "number" && !Number.isSafeInteger(value))
          return null;
        if (typeof value !== "string" && typeof value !== "number") return null;
        var text = String(value);
        return /^(?:0|[1-9]\d{0,29})$/.test(text) ? BigInt(text) : null;
      }

      function exactRate(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        var text = String(value);
        if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/.test(text)) return null;
        var parts = text.split(".");
        var scaled =
          BigInt(parts[0]) * BigInt(10000) +
          BigInt((parts[1] || "").padEnd(4, "0"));
        return scaled > BigInt(0) ? scaled : null;
      }

      function currencyFractionDigits() {
        try {
          // Liquid appends two decimal places even for JPY/KRW. This is
          // Shopify's theme-price representation, not ISO minor-unit money.
          return Math.max(
            2,
            new Intl.NumberFormat("en", {
              style: "currency",
              currency: currency.toUpperCase(),
            }).resolvedOptions().maximumFractionDigits,
          );
        } catch (_error) {
          return 2;
        }
      }

      // The public App Proxy response keeps the earn rate under data.program.
      // Shopper/tier-specific and bonus-campaign multipliers are not exposed by
      // this endpoint, so this preview deliberately shows the authoritative
      // base program rate rather than inventing an uplift.
      fetch(proxyPrefix + "/program?shop=" + encodeURIComponent(shop))
        .then(function (r) {
          if (!r.ok) throw new Error("Program unavailable");
          return r.json();
        })
        .then(function (res) {
          var payload = res && res.data ? res.data : res;
          var program = payload && payload.program;
          var configuredRate = exactRate(program?.pointsPerCurrencyUnit);
          if (
            !program ||
            program.isActive !== true ||
            configuredRate === null
          ) {
            pointsNumberEl.textContent = "—";
            return;
          }
          pointsRate = configuredRate;
          recalculate();
        })
        .catch(function () {
          pointsNumberEl.textContent = "—";
        });

      function getCurrentPriceCents() {
        // Try reading from Shopify product form or variant input
        var form = document.querySelector('form[action*="/cart/add"]');
        if (form) {
          var variantSelect = form.querySelector('[name="id"]');
          if (variantSelect) {
            var selectedOption = variantSelect.options
              ? variantSelect.options[variantSelect.selectedIndex]
              : null;
            if (selectedOption && selectedOption.getAttribute("data-price")) {
              return integerPrice(selectedOption.getAttribute("data-price"));
            }
          }
        }

        var priceAttr = container.getAttribute("data-current-price");
        return integerPrice(priceAttr);
      }

      function recalculate() {
        if (!pointsNumberEl || pointsRate === null) return;
        var rawPrice = getCurrentPriceCents();
        if (rawPrice === null) {
          pointsNumberEl.textContent = "—";
          return;
        }
        var currencyScale = BigInt(10) ** BigInt(currencyFractionDigits());
        var projected =
          (rawPrice * pointsRate) / (currencyScale * BigInt(10000));
        try {
          pointsNumberEl.textContent = projected.toLocaleString(locale);
        } catch (_error) {
          pointsNumberEl.textContent = projected.toLocaleString("en");
        }
      }

      // Variant Change Listeners
      document.addEventListener("change", function (e) {
        if (
          e.target &&
          (e.target.name === "id" ||
            e.target.closest('form[action*="/cart/add"]'))
        ) {
          setTimeout(recalculate, 50);
        }
      });

      window.addEventListener("variant:change", function (e) {
        if (
          e.detail &&
          e.detail.variant &&
          Object.prototype.hasOwnProperty.call(e.detail.variant, "price")
        ) {
          var price = integerPrice(e.detail.variant.price);
          container.setAttribute(
            "data-current-price",
            price === null ? "" : price.toString(),
          );
          recalculate();
        }
      });

      // Do not render a made-up 1x estimate while the authoritative rate loads.
      pointsNumberEl.textContent = "—";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initProductPoints);
  } else {
    initProductPoints();
  }
})();
