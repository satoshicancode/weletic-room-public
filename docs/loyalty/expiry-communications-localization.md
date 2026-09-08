# Points-expiry communication localization

Implementation checkpoint: 2026-09-09. This covers the existing warning and
last-chance email journeys, not the complete loyalty communications product.

The sender and template share an EN/JA/VI locale resolver. Supported regional
tags use their base language; missing and unsupported values use English for
both the date and message. Dates retain the existing UTC interpretation.
Merchant point names and brand names remain merchant-authored values, not
automatically translated text. Balances remain exact integer strings.

Both stages localize the subject, preview, heading, body, reward link label,
consent explanation and preference guidance. HTML declares the selected
language. Interpolated text is escaped by React; no HTML template input or
public write API is introduced.

Existing consent, participation, policy-version, date, store-generation,
pause and idempotency gates are unchanged. Localization neither enables an
email producer nor changes delivery credentials or provider configuration.

## Evidence

- 72 focused tests passed across the expiry-policy, lifecycle matrix, stress
  and new email-localization suites.
- Actual asynchronous email HTML rendering covers both stages in EN/JA/VI,
  absent names, escaping, exact large balances and account links.
- Sender tests verify supported regional tags and English fallback subjects;
  existing stale-date and consent rejection checks run for every locale case.
- Independent code review found no blocking issue.

No real email was sent. Named `yamaxdev` delivery, inbox/mobile-client visual
acceptance, merchant journey editors, reward-expiry notifications and other
loyalty communication types remain outstanding. Do not mark the overall
communications acceptance gate complete from this checkpoint.
