import { json } from "@remix-run/node";
import { Link, useLocation } from "@remix-run/react";
import IndexPage from "./_index";
export { ErrorBoundary, headers } from "./_index";

// Reachable even when ordinary SDK bootstrap is frozen. This serves only the
// static shell; status and reconnect still require fresh verified bearer POSTs.
export const loader = () =>
  json(null, { headers: { "Cache-Control": "private, no-store" } });
export default function InstallationPage() {
  const location = useLocation();
  return (
    <>
      <IndexPage />
      <p>
        <Link to={{ pathname: "/", search: location.search }}>
          Open app / アプリを開く / Mở ứng dụng
        </Link>
      </p>
    </>
  );
}
