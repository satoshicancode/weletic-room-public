import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("WRK-AUDIT-04 & WRK-AUDIT-05: Wrangler Configuration & Runbook Normalization Integrity", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const workersDir = path.join(repoRoot, "apps/web/workers");
  const runbookPath =
    "/Users/hironguyen/teamwork_projects/cloudflare_native_launch/CLOUDFLARE_NATIVE_MIGRATION_REPORT.md";

  const workerConfigs = [
    {
      name: "webhook-ingress",
      path: path.join(workersDir, "webhook-ingress/wrangler.toml"),
    },
    {
      name: "queue-consumer",
      path: path.join(workersDir, "queue-consumer/wrangler.toml"),
    },
    {
      name: "link-redirector",
      path: path.join(workersDir, "link-redirector/wrangler.toml"),
    },
    {
      name: "cron-triggers",
      path: path.join(workersDir, "cron-triggers/wrangler.toml"),
    },
  ];

  it("verifies all worker configurations use wrangler.toml and zero wrangler.jsonc files exist", () => {
    for (const config of workerConfigs) {
      expect(fs.existsSync(config.path), `Missing ${config.path}`).toBe(true);
      const jsoncPath = config.path.replace(/\.toml$/, ".jsonc");
      expect(fs.existsSync(jsoncPath), `Unexpected ${jsoncPath} found`).toBe(
        false,
      );
    }
  });

  it("verifies Cloudflare Queue resource names in wrangler.toml strictly adhere to CF naming rules", () => {
    // Cloudflare Queues names allow only alphanumeric and hyphens (no underscores!)
    const cfQueueNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$/;

    for (const config of workerConfigs) {
      const content = fs.readFileSync(config.path, "utf-8");
      const queueMatches = content.match(/^\s*queue\s*=\s*"([^"]+)"/gm) || [];
      for (const line of queueMatches) {
        const queueName = line.match(/"([^"]+)"/)?.[1];
        expect(queueName).toBeDefined();
        expect(queueName).toMatch(cfQueueNameRegex);
        expect(queueName).not.toContain("_");
      }

      const dlqMatches =
        content.match(/^\s*dead_letter_queue\s*=\s*"([^"]+)"/gm) || [];
      for (const line of dlqMatches) {
        const dlqName = line.match(/"([^"]+)"/)?.[1];
        expect(dlqName).toBeDefined();
        expect(dlqName).toMatch(cfQueueNameRegex);
        expect(dlqName).not.toContain("_");
      }
    }
  });

  it("verifies queue-consumer and ingress workers configure canonical queue names", () => {
    const ingressToml = fs.readFileSync(
      path.join(workersDir, "webhook-ingress/wrangler.toml"),
      "utf-8",
    );
    expect(ingressToml).toContain('queue = "order-webhook-queue"');
    expect(ingressToml).toContain('binding = "ORDER_WEBHOOK_QUEUE"');

    const consumerToml = fs.readFileSync(
      path.join(workersDir, "queue-consumer/wrangler.toml"),
      "utf-8",
    );
    expect(consumerToml).toContain('queue = "order-webhook-queue"');
    expect(consumerToml).toContain('dead_letter_queue = "order-webhook-dlq"');
    expect(consumerToml).toContain('queue = "order-webhook-dlq"');
    expect(consumerToml).toContain('binding = "ORDER_WEBHOOK_DLQ"');

    const cronToml = fs.readFileSync(
      path.join(workersDir, "cron-triggers/wrangler.toml"),
      "utf-8",
    );
    expect(cronToml).toContain('queue = "order-webhook-queue"');
    expect(cronToml).toContain('binding = "ORDER_WEBHOOK_QUEUE"');
  });

  it("verifies migration runbook contains zero references to wrangler.jsonc", () => {
    if (fs.existsSync(runbookPath)) {
      const runbookContent = fs.readFileSync(runbookPath, "utf-8");
      expect(runbookContent).not.toContain("wrangler.jsonc");
      expect(runbookContent).toContain("wrangler.toml");
    }
  });
});
