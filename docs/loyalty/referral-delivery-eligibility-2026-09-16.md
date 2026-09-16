# Referral email lease eligibility — September 16, 2026

Status: bounded delivery hardening with isolated evidence, not live acceptance.

Atomic email lease acquisition now allows only pending, qualified or rewarded
referrals whose reward expiry is absent or strictly later than the supplied
timestamp. Cancelled/fraud-blocked or expired rewards cannot acquire a fresh
lease or increment delivery attempts. The test-only Prisma fallback carries the
same predicates. After failed acquisition, the already-emailed lookup requires
both referral ID and store ID; it cannot disclose another store's delivery state.

## Verification

- 15 real-MySQL operations tests passed: eight new status/expiry/tenant cases plus
  existing concurrent transport lease, retry, outbox and reaper coverage.
- Exact expiry boundary rejects; one millisecond before expiry permits delivery.
  Qualified/rewarded referrals and null expiry retain existing support.
- Independent postflight found all 157 disposable schema tables empty.
- Unit coverage explicitly asserts the test-only fallback's new predicates.
- 60 focused unit tests passed. Independent adversarial review found no blockers.
- Web types, lint, Prisma validation, formatting and production build passed.
  Temporary SELECT-only build access was revoked afterward.

Database fixtures are synthetic and isolated from retained development and
production data. SMTP/Resend transports are mocked: no real email was sent.

## Remaining delivery gates

The existing caller passes claim-start `now` after remote provisioning. This
patch evaluates expiry at that supplied timestamp, not strictly at wall-clock
dispatch time. Cancellation/privacy changes after lease acquisition, installation
generation fencing across remote work, consent/retention rules, provider-level
idempotency and live delivery remain separate acceptance work. It does not close
the referrals, communications, privacy or live `yamaxdev` matrix gates.

No schema, API, provider, consent policy or authorization model changes.
