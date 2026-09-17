import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

// Keep the browser entry inside the app when workspace dependencies are symlinked.
// This preserves Vite's filesystem boundary instead of exposing another checkout.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>,
  );
});
