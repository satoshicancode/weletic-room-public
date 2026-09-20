import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FLOW_ACTION_MAX_BODY_BYTES,
  readAuthenticatedFlowPointsAction,
} from "../../lib/weletic/loyalty/flow-action-request";

const secret = "isolated-public-app-secret-for-tests-only";
const action = {
  handle: "weletic-adjust-points",
  shop_id: "12",
  shopify_domain: "fixture.myshopify.com",
  action_run_id: "run-1",
  properties: {
    customer_id: "gid://shopify/Customer/13",
    grant_id: `wflowgrant_${"a".repeat(20)}`,
    points_delta: "1",
  },
};
const body = JSON.stringify(action);
function request(
  raw: string | Uint8Array,
  key = secret,
  headers: Record<string, string> = {},
) {
  return new Request("https://example.invalid/flow", {
    method: "POST",
    body: typeof raw === "string" ? raw : Buffer.from(raw),
    headers: {
      "x-shopify-hmac-sha256": createHmac("sha256", key)
        .update(raw)
        .digest("base64"),
      ...headers,
    },
  });
}
const read = (req: Request) =>
  readAuthenticatedFlowPointsAction({ request: req, publicAppSecret: secret });

describe("Shopify Flow signed request boundary", () => {
  it("returns only the validated action, not raw bytes or signature", async () => {
    expect(await read(request(body))).toEqual({ ok: true, action });
  });
  it("authenticates exact bytes, not normalized JSON", async () => {
    const req = request(`${body} `);
    req.headers.set(
      "x-shopify-hmac-sha256",
      createHmac("sha256", secret).update(body).digest("base64"),
    );
    expect(await read(req)).toEqual({ ok: false, status: 401 });
  });
  it("rejects the custom app's secret", async () => {
    expect(
      await read(request(body, "different-custom-app-secret-0123456789")),
    ).toEqual({ ok: false, status: 401 });
  });
  it.each([
    "",
    "invalid",
    "A".repeat(43),
    `${"A".repeat(43)}=,${"A".repeat(43)}=`,
  ])("rejects malformed signature %s", async (signature) => {
    expect(
      await read(request(body, secret, { "x-shopify-hmac-sha256": signature })),
    ).toEqual({ ok: false, status: 401 });
  });
  it("does not parse unauthenticated malformed JSON", async () => {
    expect(await read(request("not-json", "wrong-key"))).toEqual({
      ok: false,
      status: 401,
    });
    expect(await read(request("not-json"))).toEqual({ ok: false, status: 400 });
  });
  it("rejects signed invalid UTF-8", async () => {
    expect(await read(request(new Uint8Array([0xff])))).toEqual({
      ok: false,
      status: 400,
    });
  });
  it("rejects signed caller-supplied staff authority", async () => {
    expect(
      await read(request(JSON.stringify({ ...action, staffId: "owner" }))),
    ).toEqual({ ok: false, status: 400 });
  });
  it("bounds streamed bodies even without Content-Length", async () => {
    expect(
      await read(request("x".repeat(FLOW_ACTION_MAX_BODY_BYTES + 1))),
    ).toEqual({ ok: false, status: 413 });
  });
  it("rejects oversized declared lengths", async () => {
    expect(
      await read(
        request(body, secret, {
          "content-length": String(FLOW_ACTION_MAX_BODY_BYTES + 1),
        }),
      ),
    ).toEqual({ ok: false, status: 413 });
  });
  it("fails closed without the configured public app secret", async () => {
    expect(
      await readAuthenticatedFlowPointsAction({
        request: request(body),
        publicAppSecret: undefined,
      }),
    ).toEqual({ ok: false, status: 503 });
  });
  it("supports only explicitly server-configured secret rotation", async () => {
    const next = "next-public-app-secret-for-tests-only";
    expect(
      await readAuthenticatedFlowPointsAction({
        request: request(body, next),
        publicAppSecret: secret,
        rotationSecret: next,
      }),
    ).toEqual({ ok: true, action });
    expect(
      await readAuthenticatedFlowPointsAction({
        request: request(body),
        publicAppSecret: secret,
        rotationSecret: "bad",
      }),
    ).toEqual({ ok: false, status: 503 });
  });
  it("rejects other methods", async () => {
    expect(await read(new Request("https://example.invalid/flow"))).toEqual({
      ok: false,
      status: 405,
    });
  });

  it("does not consume a body when signature headers are invalid", async () => {
    const req = request(body, secret, { "x-shopify-hmac-sha256": "invalid" });
    expect(await read(req)).toEqual({ ok: false, status: 401 });
    expect(req.bodyUsed).toBe(false);
  });

  it("contains stream failures without exposing their private error text", async () => {
    const req = request(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private provider detail"));
      },
    });
    Object.defineProperty(req, "body", { value: stream });
    expect(await read(req)).toEqual({ ok: false, status: 400 });
    expect(stream.locked).toBe(false);
  });
});
