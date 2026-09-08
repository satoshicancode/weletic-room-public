import {
  auditShopifyPrivacyKeyRetirement,
  serializeShopifyPrivacyKeyRetirementAudit,
} from "@/lib/weletic/shopify/privacy-key-retirement-audit";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main() {
  const retiringKeyIds = (argument("retire") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const lastWriteAt = new Date(argument("last-write-at") ?? "");
  const writersFenced = process.argv.includes("--writers-fenced");
  if (retiringKeyIds.length === 0 || !Number.isFinite(lastWriteAt.getTime())) {
    throw new Error(
      "Usage: pnpm tsx scripts/loyalty/audit-shopify-privacy-key-retirement.ts --retire=<previous-key-id[,previous-key-id]> --last-write-at=<ISO-8601> --writers-fenced. Rotate a replacement into the first/current keyring position before auditing retirement.",
    );
  }

  const result = await auditShopifyPrivacyKeyRetirement({
    retiringKeyIds,
    retiringKeyLastWriteAt: lastWriteAt,
    writersFenced,
  });
  process.stdout.write(
    `${JSON.stringify(serializeShopifyPrivacyKeyRetirementAudit(result), null, 2)}\n`,
  );
  if (!result.ready) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Shopify privacy key audit failed."}\n`,
  );
  process.exitCode = 1;
});
