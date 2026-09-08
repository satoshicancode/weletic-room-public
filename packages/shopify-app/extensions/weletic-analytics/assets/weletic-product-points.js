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

      function currencyFractionDigits() {
        try {
          return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: currency.toUpperCase(),
          }).resolvedOptions().maximumFractionDigits;
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
          return r.json();
        })
        .then(function (res) {
          var payload = res && res.data ? res.data : res;
          var program = payload && payload.program;
          var configuredRate = Number(program?.pointsPerCurrencyUnit);
          if (
            !program ||
            program.isActive !== true ||
            !Number.isFinite(configuredRate) ||
            configuredRate <= 0
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
              return parseFloat(selectedOption.getAttribute("data-price"));
            }
          }
        }

        var priceAttr = container.getAttribute("data-current-price");
        return parseFloat(priceAttr) || 0;
      }

      function recalculate() {
        if (!pointsNumberEl || pointsRate === null) return;
        var rawPrice = getCurrentPriceCents();
        var currencyScale = Math.pow(10, currencyFractionDigits());
        var priceUnits = rawPrice / currencyScale;
        var projected = Math.max(0, Math.floor(priceUnits * pointsRate));
        pointsNumberEl.textContent = projected.toLocaleString();
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
        if (e.detail && e.detail.variant && e.detail.variant.price) {
          container.setAttribute("data-current-price", e.detail.variant.price);
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
