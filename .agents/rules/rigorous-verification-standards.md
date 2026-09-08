# Rigorous Verification & Reporting Integrity Standards

Always adhere strictly to these principles before declaring any task complete or reporting that services are running:

## 1. Mandatory Live Runtime Validation (No Blind Claims)

- **Never assume a service is working based solely on static checks** (`tsc`, linting, or unit tests).
- Before reporting that a dev server, web app, or API endpoint is operational:
  1. **Send actual HTTP requests** (e.g., `curl -I -H "Host: app.localhost:8888" http://localhost:8888/<path>`) to verify real HTTP 200/30x responses.
  2. **Inspect the live server runtime logs** to ensure no unhandled exceptions, 500 errors, or missing asset errors occurred during request processing.
  3. **Verify database connectivity** if the page queries relational or cache layers.

## 2. Cache Hygiene & Process Lifecycle Management

- Whenever deleting or regenerating build caches (e.g., `rm -rf .next`, `rm -rf dist`, modifying `package.json`, or rebuilding shared monorepo packages):
  - **Always terminate stale dev server background processes first.**
  - Clean caches.
  - Start a fresh dev server process and verify clean startup logs before notifying the user.

## 3. Evidence-Based Reporting & Humility

- Do not make premature victory claims or celebratory declarations without concrete, live validation evidence.
- Provide clear, honest status updates with actual test commands and HTTP response codes.
- If any step cannot be verified with 100% certainty, transparently state what was verified and what requires user manual checking.
