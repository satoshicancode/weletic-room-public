import {
  json,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Link, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { useId, useMemo, useState } from "react";
import { ShopperBrowserSession } from "../../../../apps/web/ui/weletic/shoppers/shopper-browser";
import styles from "../customers.css?url";
import { createMerchantCustomersClient } from "../merchant-customers-client";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: styles }];
export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json(null, { headers: { "Cache-Control": "private, no-store" } });
}
export function action() {
  return json(
    { error: "method_not_allowed" },
    { status: 405, headers: { "Cache-Control": "private, no-store" } },
  );
}

export default function CustomersPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const [shopperId, select] = useState<string | null>(null);
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantCustomersClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <nav aria-label="Weletic">
        <Link to="/">Weletic</Link>
      </nav>
      <ShopperBrowserSession
        transport={transport}
        shopperId={shopperId}
        onSelect={select}
      />
    </main>
  );
}
