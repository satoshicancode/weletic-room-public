import SettingsPage from "./settings";

export { ErrorBoundary, action, headers, links, loader } from "./settings";

export default function AppearancePage() {
  return <SettingsPage appearanceOnly />;
}
