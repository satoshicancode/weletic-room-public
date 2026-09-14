import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Skip only eager route enumeration in the isolated, database-free build.
// Request-time fetchers and ordinary deployment builds keep their behavior.
export function deferLocalContainerPrerender() {
  return (
    process.env.WELETIC_LOCAL_CONTAINER_BUILD === "1" &&
    process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD
  );
}
