/** @jsxImportSource preact */
import type { Api } from "@shopify/ui-extensions/pos.home.tile.render";
import { render } from "preact";

declare const shopify: Api;

export function LoyaltyTile() {
  const hasCustomer = Boolean(shopify.cart.current.value.customer?.id);
  return (
    <s-tile
      heading="Loyalty rewards"
      subheading={
        hasCustomer ? "Redeem customer points" : "Select a customer first"
      }
      onClick={() => shopify.action.presentModal()}
    />
  );
}

export default function extension() {
  render(<LoyaltyTile />, document.body);
}
