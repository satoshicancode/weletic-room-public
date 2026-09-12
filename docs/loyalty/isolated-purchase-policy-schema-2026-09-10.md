# Isolated purchase-policy schema — September 10, 2026

Authority: [ADR 0028](../adr/0028-isolated-purchase-policy-schema.md).

## Execution

Applied only `20260908_loyalty_purchase_policy.sql` to
`127.0.0.1:3307/weletic_loyalty_dev`. Migration SHA-256:
`26e22185ae9cacce224ce17d830fb9580576db9a87d42ce6d2dbb53a30e31cde`.

The fresh private snapshot was 266,483 bytes with SHA-256
`ce49618ef24b606b03dc307426081bce5feb14b374b71dec85c84ee3a9529b4d`.
It remains outside Git in the isolated environment's private directory, mode
0600, parent 0700. No snapshot contents or credentials are published.

Exactly three ALTER TABLE statements added nullable JSON `purchasePolicy` to:

- `WeleticLoyaltyEarningRule`
- `WeleticRewardDefinition`
- `WeleticLoyaltyReferralRule`

The helper verified the database principal/server UUID, Docker project/volume,
loopback port 3307, absent application listeners on 8890/3002, no other runtime
database connections, and zero Store rows. An independent reviewer found no
concrete blocker before execution. The pinned migration was compared against the
three target Prisma differences; the generated diff was never executed.

## Verification and limitations

- All three target table definitions match Prisma after application.
- The three read-only Prisma queries that previously failed with P2022 now pass,
  returning zero rows. No fixtures or business records were inserted.
- The ten unrelated retained-schema differences are identical before and after
  the migration; import/review tables, columns, index, enum members and nullable
  tier history were preserved.
- Five focused purchase-policy/migration tests passed across two files. These
  are local contract tests, not live subscription-order acceptance.
- No application startup, deployment, installation, activation, Shopify request,
  order, email, production change or frozen import edit occurred.

The confirmed missing-column blocker is resolved. This is not full runtime or
live acceptance: retained incompatible writers must remain disabled, and public
configuration/extension identity, exposure and installation gates remain open.
