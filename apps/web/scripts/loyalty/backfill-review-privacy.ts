import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      generation: { type: "string" },
      limit: { type: "string", default: "50" },
      apply: { type: "boolean", default: false },
      "expected-preview": { type: "string" },
      operator: { type: "string" },
      "run-id": { type: "string" },
      checkpoint: { type: "string" },
      "checkpoint-output": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const [value, maximum] of [
    [values.store, 191],
    [values.generation, 64],
  ] as const)
    if (!value || value !== value.trim() || value.length > maximum)
      throw new Error("Invalid scope");
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(values.limit ?? ""))
    throw new Error("Invalid limit");
  if (values.apply) {
    if (
      !/^[a-f0-9]{64}$/.test(values["expected-preview"] ?? "") ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(values.operator ?? "") ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        values["run-id"] ?? "",
      ) ||
      !values["checkpoint-output"]
    )
      throw new Error(
        "Apply requires explicit preview, attribution and private output",
      );
  } else if (
    values["expected-preview"] ||
    values.operator ||
    values["run-id"] ||
    values["checkpoint-output"]
  )
    throw new Error("Apply-only arguments supplied to preview");

  let checkpoint;
  if (values.checkpoint) {
    const file = await open(
      values.checkpoint,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 8192 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Checkpoint must be a private owned regular file");
      const buffer = Buffer.alloc(8193);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 8192) throw new Error("Checkpoint too large");
      checkpoint = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (
        !checkpoint ||
        typeof checkpoint !== "object" ||
        Array.isArray(checkpoint)
      )
        throw new Error("Completed or invalid checkpoint");
    } finally {
      await file.close();
    }
  }

  // Reserve an exclusive private output before any SQL writes. Never overwrite
  // an earlier checkpoint. Failure/termination may leave an empty output: retry
  // from the previous checkpoint with a NEW output path; committed owners replay.
  const output = values.apply
    ? await open(
        values["checkpoint-output"]!,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
    : undefined;
  try {
    const { prisma } = await import("@/lib/prisma");
    try {
      const { loadShopifyPrivacyHmacKeyring } = await import(
        "@/lib/weletic/shopify/privacy-identity"
      );
      const { reviewPrivacyKeySetDigest } = await import(
        "@/lib/weletic/reviews/privacy-owner-contract"
      );
      const { backfillReviewOwnerPrivacyPage } = await import(
        "@/lib/weletic/reviews/privacy-owner-backfill"
      );
      const result = await backfillReviewOwnerPrivacyPage({
        storeId: values.store!,
        installationGeneration: values.generation!,
        keySetDigest: reviewPrivacyKeySetDigest(
          loadShopifyPrivacyHmacKeyring(),
        ),
        checkpoint,
        limit: Number(values.limit),
        dryRun: !values.apply,
        expectedPreviewDigest: values["expected-preview"],
        audit: values.apply
          ? { runId: values["run-id"]!, operatorReference: values.operator! }
          : undefined,
      });
      if (output) {
        await output.writeFile(JSON.stringify(result.checkpoint));
        await output.sync();
      }
      // Never print private owner cursors, key proofs, source identities or URLs.
      console.log(
        JSON.stringify({
          mode: values.apply ? "apply" : "preview",
          productionReady: false,
          ...(result.preview
            ? { preview: result.preview }
            : {
                projected: result.projected,
                suppressed: result.suppressed,
                hasMore: result.checkpoint !== null,
              }),
        }),
      );
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await output?.close();
  }
}

main().catch(() => {
  console.error(
    "Review privacy backfill failed. Some owners may have committed; inspect private audit evidence and retry from the previous checkpoint with a new output path. No readiness is implied.",
  );
  process.exitCode = 1;
});
