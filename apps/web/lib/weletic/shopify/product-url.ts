function shopifyNumericId(gid: string) {
  const value = gid.split("/").at(-1);
  return value && /^\d+$/.test(value) ? value : undefined;
}

export function buildWeleticProductTargetUrl({
  storefrontUrl,
  handle,
  variantExternalId,
  marketHandle,
  countryCode,
  locale,
  discountCode,
  subId,
  subId1,
  subId2,
  subId3,
  subId4,
  subId5,
}: {
  storefrontUrl: string;
  handle: string;
  variantExternalId?: string | null;
  marketHandle?: string | null;
  countryCode?: string | null;
  locale: string;
  discountCode?: string | null;
  subId?: string | null;
  subId1?: string | null;
  subId2?: string | null;
  subId3?: string | null;
  subId4?: string | null;
  subId5?: string | null;
}) {
  const url = new URL(storefrontUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/products/${encodeURIComponent(handle)}`.replace(
    /\/+/g,
    "/",
  );

  const variantId = variantExternalId
    ? shopifyNumericId(variantExternalId)
    : undefined;
  if (variantId) url.searchParams.set("variant", variantId);
  if (discountCode) url.searchParams.set("discount", discountCode);
  if (marketHandle) url.searchParams.set("wlt_market", marketHandle);
  if (countryCode) url.searchParams.set("wlt_country", countryCode);
  if (locale !== "en") url.searchParams.set("locale", locale);
  if (subId) url.searchParams.set("wlt_sub_id", subId);
  if (subId1) url.searchParams.set("sub1", subId1);
  if (subId2) url.searchParams.set("sub2", subId2);
  if (subId3) url.searchParams.set("sub3", subId3);
  if (subId4) url.searchParams.set("sub4", subId4);
  if (subId5) url.searchParams.set("sub5", subId5);

  return url.toString();
}
