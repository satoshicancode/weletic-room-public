import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForStableServer(
  role,
  isRunning,
  { fetchResponse = fetchServerProbe, wait = delay, now = Date.now } = {},
) {
  const deadline = now() + 30_000;
  let consecutive = 0;
  while (now() < deadline) {
    assert.ok(isRunning(), "Server exited during readiness sampling");
    try {
      assertServerProbeResponse(role, await fetchResponse(role));
      consecutive += 1;
      if (consecutive === 5 && now() < deadline) return;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      consecutive = 0;
    }
    await wait(1000);
  }
  assert.fail(
    "Server did not produce five consecutive ready responses within 30 seconds",
  );
}

export function fetchServerProbe(role) {
  const target = serverProbeRequest(role);
  return new Promise((resolve, reject) => {
    // Node 22 fetch ignores a caller-supplied Host header. Use HTTP directly;
    // this API does not follow redirects, and the target is always loopback.
    const request = httpRequest(
      target.url,
      {
        headers: target.headers,
        agent: false,
        signal: AbortSignal.timeout(1000),
      },
      (response) => {
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: new Headers({ location: response.headers.location ?? "" }),
          }),
        );
        response.resume();
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export function serverProbeRequest(role) {
  assert.ok(role === "web" || role === "shopify");
  return {
    url: "http://127.0.0.1:3000/__local_container_probe__",
    // Exercise the actual anonymous app middleware, not short-link resolution.
    // The TCP destination stays loopback and redirects are never followed.
    headers: role === "web" ? { host: "app.localhost:8888" } : {},
  };
}

export function assertServerProbeResponse(role, response) {
  assert.ok(role === "web" || role === "shopify");
  if (role === "web") {
    assert.equal(response.status, 307, "Anonymous app request must redirect");
    const location = new URL(
      response.headers.get("location"),
      serverProbeRequest(role).url,
    );
    assert.equal(location.pathname, "/login");
    assert.equal(
      location.searchParams.get("next"),
      "/__local_container_probe__",
    );
  } else {
    assert.ok(response.status < 500, "Server probe returned a server error");
  }
}
