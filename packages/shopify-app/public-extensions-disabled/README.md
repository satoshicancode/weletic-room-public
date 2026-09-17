# Public extension discovery is disabled

Keep this directory free of extension manifests. Shopify CLI interprets an empty
`extension_directories` array as its default `extensions/*` discovery pattern,
which would select the custom app's identities in this checkout.

The public foundation configuration explicitly points here instead. Public
extensions must be staged separately using the reviewed staging tool, stripped
of legacy UIDs, and reconciled with the public registration before preview.
