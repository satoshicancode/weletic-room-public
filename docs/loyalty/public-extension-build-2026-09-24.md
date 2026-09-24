# Public extension staging build — September 24, 2026

Scope: read-only source checkout at public `main` `037e80fe`. This is local
candidate-package evidence, not public-app extension ownership, deployment or
installed acceptance.

The checked-in staging tool produced a fresh private OS-temporary package with
51 allowlisted files and 13 extensions, marked `unowned_not_deployable`. The
package includes the current Loyalty, Reviews and owner-granted Flow surfaces;
it excludes the POS and Plus-only checkout targets. The source worktree stayed
clean. Shopify CLI 4.7.0 validated the staged configuration with zero issues and
built its UI and theme extensions successfully. The two declared package
dependencies were installed offline in the disposable stage.

Validation assigned 13 local candidate UIDs. They were unique and had no overlap
with the 11 UIDs in the retained source extension manifests. This disjointness
is only a local identity check. The public app currently selects zero extensions
in its checked-in configuration, and the authenticated version listing does not
expose the active public version's extension contents. Do not copy the temporary
candidate UIDs into a deployable manifest or interpret this build as remote
registration.

The next gate is an authoritative public-app UID/handle mapping, followed by
approved deployment, required protected-customer-data access, installation and
named merchant/shopper/Flow journeys. No Shopify app version, store, database,
provider resource or module setting was changed by this check.
