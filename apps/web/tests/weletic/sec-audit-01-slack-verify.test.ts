import { verifySlackSignature } from "@/lib/integrations/slack/verify-request";
import { createHmac } from "crypto";
import * as crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Slack Webhook Request Verification (SEC-AUDIT-01)", () => {
  const signingSecret = "slack-test-signing-secret-42";
  const requestBody = JSON.stringify({ command: "/dub", text: "create test" });
  const fixedNowMs = 1700000000000;
  const fixedNowSec = Math.floor(fixedNowMs / 1000);

  function createSignature(
    secret: string,
    timestamp: number,
    body: string,
    version = "v0",
  ) {
    const hmac = createHmac("sha256", secret);
    hmac.update(`${version}:${timestamp}:${body}`);
    return `${version}=${hmac.digest("hex")}`;
  }

  function makeRequest({
    signature,
    timestamp,
  }: {
    signature?: string;
    timestamp?: string | number;
  }) {
    const headers = new Headers();
    if (signature !== undefined) {
      headers.set("x-slack-signature", signature);
    }
    if (timestamp !== undefined) {
      headers.set("x-slack-request-timestamp", String(timestamp));
    }
    return new Request("https://app.dub.co/api/slack/slash-commands", {
      method: "POST",
      headers,
    });
  }

  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("successfully verifies authentic request with exact current timestamp", async () => {
    const sig = createSignature(signingSecret, fixedNowSec, requestBody);
    const req = makeRequest({ signature: sig, timestamp: fixedNowSec });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).resolves.toBeUndefined();
  });

  it("accepts requests within the 5-minute past boundary (-290 seconds)", async () => {
    const pastTs = fixedNowSec - 290;
    const sig = createSignature(signingSecret, pastTs, requestBody);
    const req = makeRequest({ signature: sig, timestamp: pastTs });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).resolves.toBeUndefined();
  });

  it("accepts requests within the 5-minute future boundary (+290 seconds)", async () => {
    const futureTs = fixedNowSec + 290;
    const sig = createSignature(signingSecret, futureTs, requestBody);
    const req = makeRequest({ signature: sig, timestamp: futureTs });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).resolves.toBeUndefined();
  });

  it("rejects requests older than 5 minutes (-301 seconds)", async () => {
    const staleTs = fixedNowSec - 301;
    const sig = createSignature(signingSecret, staleTs, requestBody);
    const req = makeRequest({ signature: sig, timestamp: staleTs });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/must differ from system time by no more than 5 minutes or request is stale/);
  });

  it("rejects requests further in the future than 5 minutes (+301 seconds - Replay Defense)", async () => {
    const futureTs = fixedNowSec + 301;
    const sig = createSignature(signingSecret, futureTs, requestBody);
    const req = makeRequest({ signature: sig, timestamp: futureTs });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/must differ from system time by no more than 5 minutes or request is stale/);
  });

  it("rejects non-numeric and NaN timestamps", async () => {
    const req = makeRequest({
      signature: "v0=abc",
      timestamp: "not-a-number",
    });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/header x-slack-request-timestamp did not have the expected type/);
  });

  it("rejects unknown signature versions", async () => {
    const req = makeRequest({
      signature: "v1=somehash",
      timestamp: fixedNowSec,
    });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/unknown signature version/);
  });

  it("rejects empty signature hash without crashing", async () => {
    const req = makeRequest({
      signature: "v0=",
      timestamp: fixedNowSec,
    });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/signature mismatch/);
  });

  it("rejects signatures with differing lengths safely without RangeError", async () => {
    const req = makeRequest({
      signature: "v0=short",
      timestamp: fixedNowSec,
    });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/signature mismatch/);
  });

  it("rejects tampered signature of correct length via constant-time check", async () => {
    const authenticSig = createSignature(signingSecret, fixedNowSec, requestBody);
    const [ver, hash] = authenticSig.split("=");
    // Corrupt the final byte of the 64-char hex
    const corruptedHash = hash.slice(0, 63) + (hash[63] === "a" ? "b" : "a");
    const tamperedSig = `${ver}=${corruptedHash}`;

    const req = makeRequest({
      signature: tamperedSig,
      timestamp: fixedNowSec,
    });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError(/signature mismatch/);
  });

  it("rejects signatures with single-byte flips across various positions", async () => {
    const authenticSig = createSignature(signingSecret, fixedNowSec, requestBody);
    const [ver, hash] = authenticSig.split("=");

    for (const pos of [0, 16, 32, 48, 63]) {
      const flipped =
        hash.slice(0, pos) +
        (hash[pos] === "a" ? "b" : "a") +
        hash.slice(pos + 1);
      const req = makeRequest({
        signature: `${ver}=${flipped}`,
        timestamp: fixedNowSec,
      });

      await expect(
        verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
      ).rejects.toThrowError(/signature mismatch/);
    }
  });

  it("fails fast when SLACK_SIGNING_SECRET is missing", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    const req = makeRequest({ signature: "v0=abc", timestamp: fixedNowSec });

    await expect(
      verifySlackSignature(req, requestBody, { nowMilliseconds: fixedNowMs }),
    ).rejects.toThrowError("SLACK_SIGNING_SECRET is not set");
  });
});
