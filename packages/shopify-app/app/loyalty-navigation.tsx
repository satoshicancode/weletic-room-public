import { Link, useRouteLoaderData } from "@remix-run/react";

const links = [
  ["/", "Weletic", true],
  ["/loyalty", "Program", true],
  ["/earning-rules", "Earning rules", true],
  ["/loyalty-rewards", "Rewards", true],
  ["/loyalty-referrals", "Referrals", false],
  ["/loyalty-vip", "VIP & campaigns", false],
  ["/loyalty-analytics", "Analytics", false],
  ["/loyalty-communications", "Communications", true],
  ["/loyalty-imports", "Imports", false],
  ["/loyalty-nudges", "Nudges", false],
  ["/loyalty-flow", "Flow permissions", true],
] as const;

export function LoyaltyNavigation() {
  const root = useRouteLoaderData<{ coreLaunch: boolean }>("root");
  return (
    <nav aria-label="Loyalty configuration">
      {links
        .filter(([, , core]) => !root?.coreLaunch || core)
        .map(([to, label], index) => (
          <span key={to}>
            {index > 0 ? " · " : ""}
            <Link to={to}>{label}</Link>
          </span>
        ))}
    </nav>
  );
}
