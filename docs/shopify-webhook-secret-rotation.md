# Shopify webhook secret rotation

This is an operational transition, not a permanent multi-key configuration.

1. Keep `SHOPIFY_WEBHOOK_SECRET` set to the oldest unrevoked provider secret. Set optional `SHOPIFY_WEBHOOK_SECRET_NEXT` to the newly generated secret on the web service. Both must remain server-only credentials.
2. Restart the web service and prove both signatures are accepted and tampering is rejected. The shared compliance reader, commerce ingress, and Flow lifecycle callback all use this overlap. Missing primary configuration still fails closed; a nonempty rotation key shorter than 32 characters rejects verification.
3. Update all OAuth consumers to the new client secret and replace or explicitly reconcile every retained token before provider revocation. Successful signature unit tests do not prove this token migration or any provider operation occurred.
4. Revoke the old secret in Shopify only after the operational gates pass.
5. Immediately set `SHOPIFY_WEBHOOK_SECRET` to the new secret and remove `SHOPIFY_WEBHOOK_SECRET_NEXT`, then restart and prove old signatures are rejected. Do not leave a compromised key configured as an overlap key.

An empty optional value is treated as unconfigured. No private credential value belongs in source, test fixtures, CI output, or this runbook.

Reference: [Shopify's credential rotation procedure](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials).
