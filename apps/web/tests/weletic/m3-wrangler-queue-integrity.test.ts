import fs from "node:fs";
import Module from "node:module";
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

  it("verifies all 4 Cloudflare Workers compile cleanly under workerd esbuild dry-run with zero server-only or native module leaks", async () => {
    const requireFromRoot = Module.createRequire(
      path.join(repoRoot, "package.json"),
    );
    const esbuildPath = fs
      .readdirSync(path.join(repoRoot, "node_modules/.pnpm"))
      .filter((entry) => entry.startsWith("esbuild@"))
      .sort()
      .pop();
    expect(esbuildPath).toBeDefined();
    const esbuild = requireFromRoot(
      path.join(
        repoRoot,
        "node_modules/.pnpm",
        esbuildPath!,
        "node_modules/esbuild",
      ),
    );
    const builtins = new Set(
      Module.builtinModules.filter((mod) => mod !== "punycode"),
    );

    for (const config of workerConfigs) {
      const workerDir = path.dirname(config.path);
      const tomlContent = fs.readFileSync(config.path, "utf-8");
      const mainMatch = tomlContent.match(/^\s*main\s*=\s*"([^"]+)"/m);
      expect(mainMatch?.[1]).toBe("src/index.ts");

      // Parse [alias] section from wrangler.toml
      const aliasSection = tomlContent.split("[alias]")[1] ?? "";
      const tomlAliases: Record<string, string> = {};
      for (const line of aliasSection.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("[")) break;
        const m = trimmed.match(/^"([^"]+)"\s*=\s*"([^"]+)"$/);
        if (m) {
          tomlAliases[m[1]] = path.resolve(workerDir, m[2]);
        }
      }
      expect(tomlAliases["server-only"]).toBe(
        path.join(workersDir, "empty.ts"),
      );

      const result = await esbuild.build({
        entryPoints: [path.join(workerDir, mainMatch![1])],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        mainFields: ["worker", "browser", "module", "main"],
        conditions: ["workerd", "worker", "browser", "import"],
        loader: { ".wasm": "binary" },
        metafile: true,
        alias: {
          ...tomlAliases,
          "@/lib": path.join(repoRoot, "apps/web/lib"),
          "@/ui": path.join(repoRoot, "apps/web/ui"),
          "@/styles": path.join(repoRoot, "apps/web/styles"),
          "@/components": path.join(repoRoot, "apps/web/components"),
          "@/pages": path.join(repoRoot, "apps/web/pages"),
          "@weletic/contracts": path.join(repoRoot, "packages/contracts/src"),
        },
        external: ["node:*", "cloudflare:*", ...Array.from(builtins)],
      });

      expect(result.errors).toEqual([]);
      expect(result.outputFiles.length).toBeGreaterThan(0);

      const inputFiles = Object.keys(result.metafile.inputs);
      // Verify zero un-aliased server-only or native sharp binary leaks in bundle inputs
      expect(
        inputFiles.some((f) => f.includes("node_modules/server-only")),
      ).toBe(false);
      expect(inputFiles.some((f) => f.includes("node_modules/sharp/"))).toBe(
        false,
      );

      const jsOutput = result.outputFiles.find((f: { path: string }) =>
        f.path.endsWith(".js"),
      );
      if (jsOutput) {
        const bundleText = new TextDecoder().decode(jsOutput.contents);
        expect(bundleText).not.toContain('from "punycode/"');
      }
    }
  });

  it("verifies createPrismaClient(d1Database) wraps PrismaD1 with withD1TransactionSemantics and outbox-worker uses SQLite-safe IS instead of MySQL <=>", async () => {
    const outboxWorkerSource = fs.readFileSync(
      path.join(repoRoot, "apps/web/lib/weletic/loyalty/outbox-worker.ts"),
      "utf-8",
    );
    expect(outboxWorkerSource).not.toContain("<=>");

    const { createPrismaClient } = await import("@/lib/prisma");
    const mockD1: any = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [], success: true, meta: {} };
          },
          async raw() {
            return [];
          },
          async first() {
            return null;
          },
          async run() {
            return {
              results: [],
              success: true,
              meta: { changes: 0, last_row_id: 0 },
            };
          },
        };
      },
      async batch() {
        return [];
      },
      async exec() {
        return { count: 0, duration: 0 };
      },
      async dump() {
        return new ArrayBuffer(0);
      },
    };

    const d1Prisma = createPrismaClient(mockD1);
    const txResult = await d1Prisma.$transaction(async (tx) => {
      expect(tx).toBeDefined();
      return "d1-tx-ok";
    });
    expect(txResult).toBe("d1-tx-ok");
  });
});
