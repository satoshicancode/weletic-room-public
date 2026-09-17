import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Skip only excluded portal enumeration in isolated or loyalty-only builds.
// Request-time fetchers and ordinary deployment builds keep their behavior.
export function deferLocalContainerPrerender() {
  return (
    (process.env.WELETIC_LOCAL_CONTAINER_BUILD === "1" ||
      process.env.WELETIC_WEB_BUILD_PROFILE === "loyalty-only") &&
    process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD
  );
}
