# First company-store bootstrap — decision proposal

Status: **Option B approved; local implementation in progress**. September 10, 2026.
Decision: [ADR 0026](../adr/0026-audited-company-store-bootstrap.md).
Evidence: [implementation checkpoint](company-store-bootstrap-implementation.md).
Related: [ADR 0025](../adr/0025-shopify-native-store-installation-identity.md).

## Why a decision is needed

The existing mapper accepts an already provisioned Store. The isolated public
environment must not copy private/custom-app workspace, session or installer
records. A Store requires unique Project and Program links; Program requires
default folder/group identifiers. Project does not require a User relation, but
its generic schema includes billing fields. Provisioning must not invoke generic
onboarding that creates subscriptions, invites, customer records or sends email.

### Options

- **A — bind existing records only:** require reviewed existing workspace and
  Program IDs, validate their relationship, and create only the Store and mapping.
  This preserves an explicit existing internal structure but leaves creation of
  those prerequisites as a separate operation in an empty environment.
- **B — dedicated per-store internal bootstrap (recommended):** an audited
  operator command creates the minimal workspace, Program and required support
  records for a company store, plus its Store/mapping. No Weletic user is selected
  or created. This removes the empty-environment prerequisite without equating
  Shopify app installation with company-wide administrator authority.

Neither option is a Shopify mandate. Shopify supplies authentication; the internal
workspace policy is Weletic's architectural choice. Unknown App Store installs
remain pending and never trigger this operator command automatically.

## Approved implementation scope for B

- Add a dedicated service and strict local CLI under `lib/weletic/shopify` and
  `scripts/loyalty`; no unauthenticated or merchant self-approval API.
- Preview first, with explicit apply, operator attribution and reason. Bind exact
  app/shop, pending ID, installation generation and pending revision. Proposed
  record IDs/names must be visible in a private preview and fenced on commit.
- Verify fresh canonical Shopify identity and currency through the current
  pending installation's authenticated credential boundary. Do not accept a
  caller-supplied currency as verified or copy a legacy token. Define the
  pre-mapping credential-read boundary explicitly before implementation.
- Revalidate identity/lifecycle and conflicts under documented lock ordering;
  concurrent bootstrap, authentication, uninstall and redaction must fail closed
  or produce one committed winner. Provider evidence cannot outlive its observed
  generation/revision. Never call SDK refresh while holding locks it requires.
- Create only required internal bookkeeping records and the immutable bootstrap
  audit in one database transaction. Preserve currency precision and program
  ownership. Require unique store/workspace/program links; reject ambiguous or
  pre-existing mappings instead of silently adopting or overwriting them.
- Keep Store access pending and loyalty disabled (or absent). Mapping/provisioning
  is not credential publication, company activation or loyalty activation. Fresh
  native authentication and existing explicit company-approval gates still apply.
- Create no User, ProjectUsers membership, generic InstalledIntegration, billing
  subscription, invitation, customer sync, order, referral, reward or email.
  Populate unavoidable generic schema fields as inert bookkeeping only, with
  explicit tests that no inherited billing/onboarding side effects are called.
- Retain existing reconnect behavior: reinstall reuses a valid retained mapping
  after applicable cleanup and fresh authentication, not this initial bootstrap.

## Contracts, migrations and verification

Reuse existing records where their contracts suffice; do not assume an audit
schema supports a new operation until inspected. If a new schema or audit enum is
needed, present that delta separately before applying it to any runtime database.
No runtime DDL, endpoint/DNS changes, deployment or installation is authorized by
this proposal. Initial implementation uses synthetic provider transport and fresh
isolated MySQL fixtures on the already approved port-3307 instance.

Required tests: unauthorized/unknown store; foreign app/workspace/program; stale
pending revision/generation; expired provider evidence; duplicate retry; competing
bootstrap; privacy race; orphan/collision rejection; atomic failure rollback;
independent SQL reconciliation; zero user/installer/customer/billing/send effects;
approval and loyalty remain disabled. Then named `yamaxdev` first-install,
authentication, approval and reinstall evidence, under separate live approval.

Definition of done: the selected policy is approved, implemented and reviewed;
all local contract/SQL/build gates pass; applicable named live evidence is recorded.
Neither a preview nor pre-created fixtures count as completed first-install flow.

## Other pending decision

Dedicated HTTPS hostnames remain proposed, not approved:
`loyalty-shopify-dev.weletic.com` and `loyalty-api-dev.weletic.com`.
Hostname selection is separate from authority to create DNS/tunnels or expose
services. No answer is inferred from automatic goal continuations.
