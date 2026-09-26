/** Shape checks only: provider ownership and real subscriptions need acceptance. */
export function assertCoreBillingEnvironment(role, env) {
  const fail = () => {
    throw new Error("Core billing configuration rejected");
  };
  if (role === "shopify") {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(env.SHOPIFY_APP_HANDLE ?? "") ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.WELETIC_SUPPORT_EMAIL ?? "")
    )
      fail();
    if (env.SHOPIFY_PARTNER_API_TOKEN !== undefined) fail();
    return;
  }
  if (
    !/^gid:\/\/shopify\/App\/[1-9][0-9]*$/.test(
      env.SHOPIFY_PARTNER_APP_ID ?? "",
    )
  )
    fail();
  if (role === "outbox") {
    if (env.SHOPIFY_PARTNER_API_TOKEN !== undefined) fail();
    return;
  }
  if (
    !/^[1-9][0-9]*$/.test(env.SHOPIFY_PARTNER_ORGANIZATION_ID ?? "") ||
    typeof env.SHOPIFY_PARTNER_API_TOKEN !== "string" ||
    env.SHOPIFY_PARTNER_API_TOKEN.trim().length < 16
  )
    fail();
  const handles = [
    env.WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE,
    env.WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE,
  ];
  if (
    handles.some(
      (handle) =>
        typeof handle !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,190}$/.test(handle),
    ) ||
    handles[0] === handles[1]
  )
    fail();
}
