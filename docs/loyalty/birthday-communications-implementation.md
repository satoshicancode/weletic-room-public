# Birthday communications — implementation plan

This follows the approved loyalty communications stream. Branch starts from public
main `aaecadfbc0`; signup PR #22 remains separate. No activation or delivery is
authorized by this implementation.

- Scope: notify only after the existing annual birthday award posts points. Keep
  the current eligibility, anti-gaming, leap-day and scheduling rules unchanged.
- Contract: immutable exact points, ledger/account/store/program identity,
  installation generation, award year, occurrence time and birthday policy revision.
  No birth date, recipient, invented purchase or coupon. Reject non-birthday earns,
  grant-backed entries, mismatched annual keys and foreign tenant evidence.
- Producer: use the real ledger created receipt in the same store/program-fenced
  transaction; rollback on outbox failure; no retroactive opt-in or replay notices.
- Delivery: extend the existing communication reader/worker and encrypted retained
  request path; use the birthday policy and localized points reward context. Keep
  consent, privacy, suppression, pause, generation and provider retry guards.
- Tests: exact arithmetic, provenance, yearly/replay deduplication, policy edits,
  rollback and races in isolated MySQL, EN/JA/VI rendering, retained retry and
  redaction before/after worker completion. No real recipients or sends.
- No migrations, new provider, public API, authorization model or birthday policy.
  Upgrade strict readers/workers before enabling the new producer. Real delivery,
  store timezone confirmation and named yamaxdev acceptance remain external gates.

## Draft checkpoint

The producer, annual award receipt boundary, job schema, birthday-specific sender
and retained-request policy selection are implemented locally. The initial seven
focused suites passed 110 tests. Four retention/source suites then passed 86 tests
after adding birthday-specific saved-request checks; these counts overlap.

Tests cover exact points, annual provenance, tenant/policy mismatch, deterministic
keys, unsupported fields, EN/JA/VI source rendering and encrypted retained retry.
Birthday enablement succeeds with points-earned disabled; the inverse is rejected
both on first admission and encrypted retry. These use mocked adapters, not real
provider sends or live shopper sessions.

Independent review found a missing birthday member in the shared policy snapshot
parameter type. It was fixed; the subsequent full web typecheck passed. The first
typecheck failed on that omission and is not counted as successful evidence.
Review found no other concrete financial/privacy/source defect, but requested
actual award transaction replay/rollback evidence before publication. The expanded
SQL suite passed all 17 tests, including three actual birthday award cases:
concurrent annual replay creates one notification; later opt-in does not backfill
an old award but the next year creates a fresh event; injected outbox failure rolls
back the ledger and balance. Independent checks found zero fixture rows in all ten
checked tables and the temporary grant was revoked. This is local MySQL evidence,
not real email delivery or a forced distributed-lock interleaving. Focused lint
also passed.

The first full regression reported 6,278 passed, six skipped and two failed tests
in the outbox harness. The synthetic birthday worker fixture did not mock the new
producer boundary, leaving the existing tier test failing later in that suite.
The harness now explicitly mocks notification production; actual producer
transaction behavior remains covered by the SQL suite above. Independent review
also caught shared object identity between a retained event's policy and the
mocked current policy. The current policy is now cloned, and the tests assert
the immutable event remains enabled when current delivery is disabled, both
before first send and on encrypted retry. Both corrected suites passed all
85 tests. The complete corrected regression then passed all 404 files:
6,280 tests passed and six were skipped, in 330.46 seconds with two workers.
The earlier failed run is not counted as a passing result.

The isolated web production build passed type validation and generated all 367
static pages. Independent postflight checks found zero rows in all ten fixture
tables, and the temporary SELECT grant was revoked. Full web lint also passed.
The final corrected-snapshot web typecheck also passed.
The production source was unchanged during the build; subsequent corrections
affected only test fixtures and documentation.

## Combined signup/birthday checkpoint

Signup PR #22 merged as `3427d1e3c649dcf019f736f599a95c50b156eaa1` after all
six public checks passed. This local integration retains purchase, signup and
birthday source variants. The combined SQL suite passed 24 tests, adding birthday
retained-request erasure before and after worker completion. Ten fixture tables
reconciled to zero and the temporary grant was revoked. The SQL sender and Redis
lock remain synthetic; these tests do not prove real delivery or lock contention.

The merchant response now explicitly reports
`purchase_signup_birthday_and_expiry_policies`. EN/JA/VI copy separates the Birthday
journey from purchase/signup notices and leaves other journeys disconnected.
Older readiness values retain their meaning. Strict merchant readers must be
upgraded before this backend value is emitted, or deploy both in the coordinated
drained rollout with updated workers. No activation or deployment is implied.

All 51 editor/contract/client/action tests passed after correcting the new save
fixture to return the saved policy and a changed revision. The first integrated
focused run passed 239 tests but failed three UI fixture cases; those failures
were not production defects or waived checks. Combined web typecheck passed.
Independent integration review found no financial/privacy/source blocker.

Combined full lint passed. Signup main's post-merge run `34484412037` also passed;
that is main evidence, not CI for this birthday branch.

## Bounded local browser evidence — September 10, 22:50–22:54 JST

The actual shared editor and Shopify CSS were bundled from the combined branch
and served only on `127.0.0.1:4189`, with an in-memory synthetic transport. EN/JA/VI
editor copy and corresponding birthday templates rendered at 375 × 812 without
horizontal overflow or fixture store/generation identifiers in the DOM. Japanese
and Vietnamese screenshots were visually inspected outside the repository.
Keyboard Tab reached Save and Enter saved the edited birthday subject; dirty
state locked journey selection and the saved message explicitly said no email
was sent. Birthday enablement remained off throughout.

Synthetic read-only permission disabled the form, loading disabled reload, and
initial errors showed a sanitized reload instruction. An ambiguous save disabled
the form/retry and did not expose the synthetic private error. These state checks
were performed in English; full EN/JA/VI permission/error combinations and
screen-reader testing remain unaccepted. The only browser resource error was a
missing fixture favicon. This is not Shopify authentication, real gateway writes,
provider delivery or a live shopper journey. Fixture/artifacts remain outside the
public repository at `/tmp/weletic-birthday-browser.kazbnK`.

Still required: combined full regression/build, public CI, full browser acceptance
and named live acceptance. Birthday code has not been published. The preceding
birthday-only build and full-suite counts are historical checkpoint evidence,
not proof of this combined snapshot.
