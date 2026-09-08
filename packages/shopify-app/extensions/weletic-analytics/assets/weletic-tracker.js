/**
 * Weletic Conversion & Partner Attribution Tracker
 * Injected automatically by the Weletic Theme App Extension
 */
(function () {
  "use strict";

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const clickId =
      urlParams.get("d_id") ||
      urlParams.get("dub_id") ||
      urlParams.get("via") ||
      urlParams.get("partner") ||
      urlParams.get("ref");

    const referralCode = urlParams.get("ref");
    if (referralCode) {
      window.sessionStorage.setItem("weletic_referral_code", referralCode);
    }

    if (clickId) {
      // Store partner attribution cookie (30-day lifetime)
      const maxAge = 60 * 60 * 24 * 30;
      document.cookie = `weletic_click_id=${encodeURIComponent(clickId)}; path=/; max-age=${maxAge}; SameSite=Lax`;
      window.sessionStorage.setItem("weletic_click_id", clickId);

      // Auto-apply referral discount if present
      const discountCode = urlParams.get("discount") || urlParams.get("code");
      if (discountCode) {
        fetch(`/discount/${encodeURIComponent(discountCode)}`, {
          method: "GET",
          credentials: "same-origin",
        }).catch(function (err) {
          console.warn("[Weletic] Auto-discount application skipped:", err);
        });
      }
    }
  } catch (e) {
    console.warn("[Weletic Tracker] Initialization note:", e);
  }
})();
