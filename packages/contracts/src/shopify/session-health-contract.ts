// Shared by the worker, privacy cleanup, merchant API and presentation layer.
// This is an operational incident, never a financial reconciliation finding.
export const SHOPIFY_SESSION_MISSING_ISSUE_KIND = "shopify_session_missing";

export type ShopifySessionHealth = {
  status: "not_connected" | "reconnect_required" | "not_observed";
  detectedAt: string | null;
};
