import { Link } from "@remix-run/react";

export function LoyaltyNavigation() {
  return (
    <nav aria-label="Loyalty configuration">
      <Link to="/">Weletic</Link> · <Link to="/loyalty">Program</Link> ·{" "}
      <Link to="/earning-rules">Earning rules</Link> ·{" "}
      <Link to="/loyalty-rewards">Rewards</Link> ·{" "}
      <Link to="/loyalty-referrals">Referrals</Link> ·{" "}
      <Link to="/loyalty-vip">VIP & campaigns</Link> ·{" "}
      <Link to="/loyalty-analytics">Analytics</Link> ·{" "}
      <Link to="/loyalty-communications">Communications</Link> ·{" "}
      <Link to="/loyalty-imports">Imports</Link> ·{" "}
      <Link to="/loyalty-nudges">Nudges</Link>
    </nav>
  );
}
