/** Management guidance, not an assertion of installation or live health. */
export function ShopifyConnectionManagementNotice() {
  return (
    <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
      <h1 className="text-lg font-semibold">Shopify connection</h1>
      <p className="text-sm text-neutral-700">
        Installation and authentication are managed through Shopify Admin. Open
        Weletic in the intended store to authenticate or reconnect. Use that
        store’s app settings to uninstall.
      </p>
      <p className="text-sm text-neutral-600">
        The connection belongs to the store and app, not a Weletic installer
        account. Shopify user permissions and company-store approval remain
        separate; authentication alone does not activate loyalty.
      </p>
      <a
        href="https://admin.shopify.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Open Shopify Admin (opens in a new tab)
      </a>
    </section>
  );
}
