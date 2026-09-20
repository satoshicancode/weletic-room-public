import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      generation: { type: "string" },
      sources: { type: "boolean", default: false },
      "max-pages": { type: "string" },
      "page-size": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const [value, maximum] of [
    [values.store, 191],
    [values.generation, 64],
  ] as const) {
    if (!value || value !== value.trim() || value.length > maximum)
      throw new Error("Inspection arguments invalid");
  }
  for (const value of [values["max-pages"], values["page-size"]])
    if (
      value !== undefined &&
      (!values.sources || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value))
    )
      throw new Error("Inspection page bound invalid");
  // Keep application startup inside the sanitized failure boundary too.
  const { prisma } = await import("@/lib/prisma");
  try {
    if (values.sources) {
      const { reconcileReviewPrivacySourcePage } = await import(
        "@/lib/weletic/reviews/privacy-source-reconciliation"
      );
      let checkpoint;
      let pages = 0;
      let checked = 0;
      let orphanReviews: number | null = null;
      const counts = {
        matched: 0,
        missing: 0,
        mismatched: 0,
        invalidSource: 0,
        suppressedClean: 0,
        suppressedPending: 0,
      };
      do {
        const page = await reconcileReviewPrivacySourcePage({
          storeId: values.store!,
          installationGeneration: values.generation!,
          checkpoint,
          limit: Number(values["page-size"] ?? "50"),
        });
        for (const key of Object.keys(counts) as Array<keyof typeof counts>)
          counts[key] += page.counts[key];
        checked += page.checked;
        if (page.orphanReviews !== null) orphanReviews = page.orphanReviews;
        pages++;
        checkpoint = page.checkpoint ?? undefined;
      } while (checkpoint && pages < Number(values["max-pages"] ?? "100"));
      const scanComplete = checkpoint === undefined;
      console.log(
        JSON.stringify({
          scope: "persisted_review_owners",
          productionReady: false,
          consistentStoreSnapshot: false,
          scanComplete,
          pages,
          checked,
          orphanReviews,
          counts,
        }),
      );
      if (
        !scanComplete ||
        orphanReviews === null ||
        orphanReviews > 0 ||
        counts.missing ||
        counts.mismatched ||
        counts.invalidSource ||
        counts.suppressedPending
      )
        process.exitCode = 1;
      return;
    }
    const { inspectReviewPrivacyReaderCoverage } = await import(
      "@/lib/weletic/reviews/privacy-readiness"
    );
    const result = await inspectReviewPrivacyReaderCoverage({
      storeId: values.store!,
      installationGeneration: values.generation!,
    });
    // Read-only operator diagnostic. Counts only; do not print source/customer
    // identities, database URLs, keyring fingerprints or raw failure objects.
    console.log(
      JSON.stringify({
        scope: "currently_publishable_reviews",
        productionReady: false,
        ...result,
      }),
    );
    if (!result.readerCoverageComplete) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "Review privacy inspection failed; privately verify the exact store, generation, schema and key configuration.",
  );
  process.exitCode = 1;
});
