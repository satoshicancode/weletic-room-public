import { recordApiLog } from "@/lib/api-logs/record-api-log";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tinybird", () => ({
  tb: { buildIngestEndpoint: () => mocks.ingest },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  ["development", "1", false],
  ["development", "", true],
  ["production", "1", true],
])(
  "isolated API telemetry for %s / %s",
  async (environment, isolated, sends) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", isolated);
    await recordApiLog({
      workspaceId: "isolated-workspace",
      method: "POST",
      path: "/api/shopify/integration/webhook",
      routePattern: "/shopify/integration/webhook",
      statusCode: 200,
      duration: 1,
      userAgent: null,
      requestBody: { email: "fixture@example.test" },
      responseBody: {},
      tokenId: null,
      userId: null,
      requestType: "webhook",
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(sends ? 1 : 0);
  },
);
