// A distinct mutation endpoint makes mixed-version deployment fail closed:
// old backend instances return 404 instead of ignoring an unfamiliar proof.
export { DELETE, POST } from "../route";
export const dynamic = "force-dynamic";
