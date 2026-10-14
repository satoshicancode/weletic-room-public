import { startMockMailhog } from "./mock-mailhog";

startMockMailhog()
  .then(() => {
    console.log("[Mock MailHog] Listening on SMTP :1025 and HTTP :8025");
  })
  .catch((err) => {
    console.error("[Mock MailHog] Failed to start:", err);
    process.exit(1);
  });
