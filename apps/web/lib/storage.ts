import { OG_AVATAR_URL, R2_URL, fetchWithTimeout } from "@dub/utils";
import { AwsClient } from "aws4fetch";
import dnsCallback, { promises as dns } from "dns";
import { isIP } from "net";

type Buffer = Uint8Array;

const pinnedDnsMap = new Map<string, string>();
let dnsHookInstalled = false;

function assertSafeIpGlobal(address: string): void {
  const addr = address.toLowerCase();
  const mappedIPv4 = addr.startsWith("::ffff:");
  const parts = (mappedIPv4 ? addr.slice("::ffff:".length) : address)
    .split(".")
    .map(Number);
  const isPrivateIPv4 =
    parts.length === 4 &&
    (parts[0] === 127 || // loopback 127.0.0.0/8
      parts[0] === 10 || // private 10.0.0.0/8
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // private 172.16.0.0/12
      (parts[0] === 192 && parts[1] === 168) || // private 192.168.0.0/16
      (parts[0] === 169 && parts[1] === 254) || // link-local 169.254.0.0/16
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // CGNAT 100.64.0.0/10
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || // Benchmark 198.18.0.0/15
      parts[0] >= 224 || // multicast 224.0.0.0/4 and reserved 240.0.0.0/4
      parts[0] === 0); // unspecified 0.0.0.0/8

  const isPrivateIPv6 =
    addr === "::1" || // loopback
    addr === "::" || // unspecified
    mappedIPv4 || // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    addr.startsWith("fc") || // unique local fc00::/7
    addr.startsWith("fd") || // unique local fc00::/7
    /^fe[89ab]/.test(addr); // link-local fe80::/10

  if (isPrivateIPv4 || isPrivateIPv6) {
    throw new Error("URL resolves to a private or internal IP address.");
  }
}

function installDnsPinHook() {
  if (dnsHookInstalled) return;
  dnsHookInstalled = true;
  const originalLookup = dnsCallback.lookup;

  // @ts-expect-error - node internal signature matching
  dnsCallback.lookup = function (
    hostname: string,
    options: any,
    callback: any,
  ) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" ? options : {};
    const lower = (hostname || "").toLowerCase();

    if (pinnedDnsMap.has(lower)) {
      const pinnedIp = pinnedDnsMap.get(lower)!;
      if (opts?.all) {
        return cb(null, [
          { address: pinnedIp, family: pinnedIp.includes(":") ? 6 : 4 },
        ]);
      }
      return cb(null, pinnedIp, pinnedIp.includes(":") ? 6 : 4);
    }

    return originalLookup.call(
      dnsCallback,
      hostname,
      options,
      (err: any, address: any, family: any) => {
        if (err) return cb(err);
        try {
          if (Array.isArray(address)) {
            for (const item of address) {
              assertSafeIpGlobal(item.address);
            }
          } else if (address) {
            assertSafeIpGlobal(address);
          }
          cb(null, address, family);
        } catch (validationErr) {
          cb(validationErr);
        }
      },
    );
  };
}

interface imageOptions {
  signal?: AbortSignal;
  /** The caller owns durable write/reconciliation state; never retry the PUT. */
  singleAttempt?: boolean;
  contentType?: string;
  width?: number;
  height?: number;
  headers?: Record<string, string>;
}

type BucketType = "public" | "private";

class StorageClient {
  get accessKeyId(): string {
    return (
      process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || ""
    );
  }

  get secretAccessKey(): string {
    return (
      process.env.STORAGE_SECRET_ACCESS_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      ""
    );
  }

  get endpoint(): string {
    return process.env.STORAGE_ENDPOINT || process.env.AWS_ENDPOINT || "";
  }

  get baseUrl(): string {
    return (
      process.env.STORAGE_BASE_URL || process.env.NEXT_PUBLIC_CDN_URL || ""
    );
  }

  get publicBucket(): string {
    return (
      process.env.STORAGE_PUBLIC_BUCKET ||
      process.env.AWS_S3_BUCKET ||
      "weletic-prod-public"
    );
  }

  get privateBucket(): string {
    return (
      process.env.STORAGE_PRIVATE_BUCKET ||
      process.env.AWS_S3_PRIVATE_BUCKET ||
      "weletic-prod-private"
    );
  }

  private get client(): AwsClient {
    return new AwsClient({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  async upload({
    key,
    body,
    opts,
    bucket = "public",
  }: {
    key: string;
    body: Blob | Buffer | string;
    opts?: imageOptions;
    bucket?: BucketType;
  }) {
    const configuredBucket =
      bucket === "private" ? this.privateBucket : this.publicBucket;
    if (
      !this.endpoint ||
      !configuredBucket ||
      !this.accessKeyId ||
      !this.secretAccessKey
    ) {
      if (bucket === "private") {
        throw new Error("Private storage is not fully configured.");
      }
      if (typeof body === "string") {
        return {
          url:
            body.startsWith("data:") || body.startsWith("http")
              ? body
              : `${(this.baseUrl || R2_URL || "https://assets.dub.co").replace(/\/$/, "")}/${key}`,
        };
      }
      return {
        url: `${(this.baseUrl || R2_URL || "https://assets.dub.co").replace(/\/$/, "")}/${key}`,
      };
    }

    let uploadBody;
    if (typeof body === "string") {
      if (this.isBase64(body)) {
        uploadBody = this.base64ToArrayBuffer(body, opts);
      } else if (this.isUrl(body)) {
        uploadBody = await this.urlToBlob(body, opts);
      } else {
        throw new Error("Invalid input: Not a base64 string or a valid URL");
      }
    } else {
      uploadBody = body;
    }

    const size =
      uploadBody instanceof Blob
        ? uploadBody.size
        : uploadBody instanceof ArrayBuffer ||
            uploadBody instanceof Uint8Array ||
            Buffer.isBuffer(uploadBody)
          ? uploadBody.byteLength
          : typeof uploadBody === "string"
            ? Buffer.byteLength(uploadBody)
            : (uploadBody as any)?.size ??
              (uploadBody as any)?.byteLength ??
              (uploadBody as any)?.length;

    const headers: Record<string, string> = {
      ...(size != null ? { "Content-Length": size.toString() } : {}),
      ...opts?.headers,
    };

    if (opts?.contentType) {
      headers["Content-Type"] = opts.contentType;
    }

    // Zero S3 ACL headers: Cloudflare R2 explicitly rejects x-amz-acl
    delete headers["x-amz-acl"];
    delete headers["X-Amz-Acl"];

    try {
      const client = this.client;
      if (opts?.singleAttempt) client.retries = 0;
      const response = await client.fetch(
        `${this.endpoint}/${this._getBucketName(bucket)}/${key}`,
        {
          method: "PUT",
          ...(opts?.singleAttempt ? { redirect: "error" as const } : {}),
          signal: opts?.signal,
          headers,
          body: uploadBody,
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error(
          `R2 response not ok: ${response.status} ${response.statusText}`,
          errorText,
        );
        throw new Error(
          `${response.status} ${response.statusText}: ${errorText}`,
        );
      }

      return {
        url: `${(this.baseUrl || R2_URL || "").replace(/\/$/, "")}/${key}`,
      };
    } catch (error) {
      console.error("storage.upload failed", error);
      throw new Error("Failed to upload file. Please try again later.");
    }
  }

  /** Positive-evidence recovery only. Default R2 S3 endpoint, never CDN/custom
   * domains. A null result is not proof that an earlier PUT cannot still finish.
   */
  async headPrivateR2Object(key: string) {
    const url = this.privateR2ObjectUrl(key);
    const client = this.client;
    client.retries = 0;
    const response = await client.fetch(url, {
      method: "HEAD",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new Error("Private R2 metadata is unavailable");
    const length = response.headers.get("content-length");
    const type = response.headers.get("content-type");
    const proof = response.headers.get("x-amz-meta-weletic-upload-proof");
    if (
      !length ||
      !/^(?:0|[1-9][0-9]{0,9})$/.test(length) ||
      !type ||
      type.length > 128
    )
      throw new Error("Private R2 metadata is invalid");
    return {
      sizeBytes: Number(length),
      contentType: type,
      uploadProof: proof && /^[0-9a-f]{64}$/.test(proof) ? proof : null,
    };
  }

  /** Internal byte retrieval. Caller must prove ownership and recheck privacy
   * before delivering bytes. Never returns a transferable storage capability.
   */
  async readPrivateR2Object(key: string, expectedBytes: number) {
    if (
      !Number.isInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > 2 * 1024 * 1024
    )
      throw new Error("Private object size is invalid");
    const url = this.privateR2ObjectUrl(key);
    const client = this.client;
    client.retries = 0;
    const response = await client.fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (
      response.status !== 200 ||
      response.headers.get("content-type") !== "image/webp" ||
      response.headers.get("content-length") !== String(expectedBytes) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error("Private object response is invalid");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > expectedBytes)
          throw new Error("Private object exceeds its declared size");
        chunks.push(Buffer.from(value));
      }
      if (length !== expectedBytes)
        throw new Error("Private object was truncated");
      return Buffer.concat(chunks, length);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private privateR2ObjectUrl(key: string) {
    const endpointStr = this.endpoint || "https://invalid.invalid";
    let endpoint: URL;
    try {
      endpoint = new URL(endpointStr);
    } catch {
      throw new Error(
        "Direct private R2 storage is not configured for reconciliation",
      );
    }
    const bucket = this.privateBucket;

    const isProduction = process.env.NODE_ENV === "production";
    const isDirectR2 =
      endpoint.protocol === "https:" &&
      /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) &&
      !endpoint.port;
    const isLocalOrTest =
      !isProduction &&
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      (endpoint.hostname === "localhost" ||
        endpoint.hostname === "127.0.0.1" ||
        endpoint.hostname === "::1" ||
        endpoint.hostname.endsWith(".localhost") ||
        endpoint.hostname.endsWith(".local") ||
        endpoint.hostname === "test-storage" ||
        endpoint.hostname.startsWith("test-") ||
        process.env.STORAGE_ALLOW_TEST_ENDPOINT === "1" ||
        process.env.STORAGE_ALLOW_TEST_ENDPOINT === "true");

    const isEndpointValid = isDirectR2 || isLocalOrTest;

    if (
      !isEndpointValid ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      !bucket ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      !this.accessKeyId ||
      !this.secretAccessKey ||
      !key ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(
        "Direct private R2 storage is not configured for reconciliation",
      );
    return `${endpoint.origin}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async delete({
    key,
    bucket = "public",
  }: {
    key: string;
    bucket?: BucketType;
  }) {
    const configuredBucket =
      bucket === "private" ? this.privateBucket : this.publicBucket;
    if (
      !this.endpoint ||
      !configuredBucket ||
      !this.accessKeyId ||
      !this.secretAccessKey
    ) {
      if (bucket === "private") {
        throw new Error("Private storage is not fully configured.");
      }
      return;
    }

    try {
      const response = await this.client.fetch(
        `${this.endpoint}/${this._getBucketName(bucket)}/${key}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error(response.statusText);
      }
    } catch (error) {
      console.error("storage.delete failed", error);
      throw new Error("Failed to delete file. Please try again later.");
    }
  }

  async getSignedUrl({
    key,
    method,
    expiresIn,
    bucket,
    headers,
  }: {
    key: string;
    method: "PUT" | "GET" | "HEAD";
    bucket: BucketType;
    expiresIn: number;
    headers?: Record<string, string>;
  }) {
    const url = new URL(
      `${this.endpoint}/${this._getBucketName(bucket)}/${key}`,
    );

    url.searchParams.set("X-Amz-Expires", String(expiresIn));

    // Zero S3 ACL headers: Cloudflare R2 explicitly rejects x-amz-acl
    if (headers) {
      delete headers["x-amz-acl"];
      delete headers["X-Amz-Acl"];
    }

    try {
      const response = await this.client.sign(url, {
        method,
        headers,
        aws: {
          signQuery: true,
          allHeaders: true,
        },
      });

      return response.url;
    } catch (error) {
      console.error("storage.getSignedUrl failed", error);
      throw new Error("Failed to generate signed url. Please try again later.");
    }
  }

  async getSignedUploadUrl(opts: {
    key: string;
    bucket?: BucketType;
    expiresIn?: number;
    contentLength?: number;
    contentType?: string;
  }) {
    const headers: Record<string, string> = {};

    if (opts.contentLength) {
      headers["Content-Length"] = String(opts.contentLength);
    }

    if (opts.contentType) {
      headers["Content-Type"] = opts.contentType;
    }

    return await this.getSignedUrl({
      key: opts.key,
      method: "PUT",
      bucket: opts.bucket || "public",
      expiresIn: opts.expiresIn || 600,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  }

  async getSignedDownloadUrl(opts: {
    key: string;
    bucket?: BucketType;
    expiresIn?: number;
  }) {
    return await this.getSignedUrl({
      key: opts.key,
      method: "GET",
      bucket: opts.bucket || "private",
      expiresIn: opts.expiresIn || 600,
    });
  }

  async head({
    key,
    bucket = "private",
  }: {
    key: string;
    bucket?: BucketType;
  }) {
    const url = await this.getSignedUrl({
      key,
      method: "HEAD",
      bucket,
      expiresIn: 60,
    });
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Stored object is unavailable.");
    return {
      contentLength: Number(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
    };
  }

  private base64ToArrayBuffer(base64: string, opts?: imageOptions) {
    const base64Data = base64.replace(/^data:.+;base64,/, "");
    const paddedBase64Data = base64Data.padEnd(
      base64Data.length + ((4 - (base64Data.length % 4)) % 4),
      "=",
    );

    const binaryString = atob(paddedBase64Data);
    const byteArray = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      byteArray[i] = binaryString.charCodeAt(i);
    }
    const blobProps = {};
    if (opts?.contentType) blobProps["type"] = opts.contentType;
    return new Blob([byteArray], blobProps);
  }

  private isBase64(str: string) {
    const base64Regex =
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

    const dataImageRegex =
      /^data:image\/[a-zA-Z0-9.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

    return base64Regex.test(str) || dataImageRegex.test(str);
  }

  private isUrl(str: string): boolean {
    try {
      new URL(str);
      return true;
    } catch (_) {
      return false;
    }
  }

  private async assertSafeUrl(
    url: string,
  ): Promise<{ hostname: string; safeIp: string }> {
    const { hostname, protocol } = new URL(url);

    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("Only http and https URLs are allowed.");
    }

    const lowerHost = hostname.toLowerCase();
    if (
      lowerHost === "localhost" ||
      lowerHost.endsWith(".localhost") ||
      lowerHost.endsWith(".local") ||
      lowerHost.endsWith(".internal")
    ) {
      throw new Error("URL resolves to a private or internal hostname.");
    }

    let addresses: string[];
    if (isIP(hostname) !== 0) {
      addresses = [hostname];
    } else {
      const results = await dns.lookup(hostname, { all: true });
      addresses = results.map((r) => r.address);
    }

    if (!addresses.length) {
      throw new Error("URL does not resolve to any IP address.");
    }

    for (const address of addresses) {
      this.assertSafeIp(address);
    }

    return { hostname: lowerHost, safeIp: addresses[0] };
  }

  private assertSafeIp(address: string): void {
    assertSafeIpGlobal(address);
  }

  private async safeFetch(url: string): Promise<Response> {
    installDnsPinHook();
    const maxRedirects = 5;
    let currentUrl = url;

    for (
      let redirectCount = 0;
      redirectCount <= maxRedirects;
      redirectCount++
    ) {
      const { hostname, safeIp } = await this.assertSafeUrl(currentUrl);
      pinnedDnsMap.set(hostname, safeIp);

      try {
        const response = await fetchWithTimeout(currentUrl, {
          redirect: "manual",
        });

        if (response.ok) {
          return response;
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error("Redirect response missing location header");
          }
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }

        throw new Error(
          `Failed to fetch URL: ${response.status} ${response.statusText}`,
        );
      } finally {
        pinnedDnsMap.delete(hostname);
      }
    }

    throw new Error("Too many redirects");
  }

  private async urlToBlob(url: string, opts?: imageOptions): Promise<Blob> {
    const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5MB limit
    const ALLOWED_IMAGE_MIME_TYPES = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif",
    ]);

    // Always fetch via safeFetch to guarantee assertSafeUrl on origin and redirects
    const response = await this.safeFetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.statusText}`);
    }

    const rawContentType =
      opts?.contentType || response.headers.get("content-type") || "";
    const mimeType = rawContentType.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Invalid or unsupported image MIME type: ${rawContentType || "unspecified"}. Allowed types are: image/jpeg, image/png, image/webp, image/gif, image/avif`,
      );
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("File size exceeds maximum allowed limit of 5MB");
      }
    }

    let arrayBuffer: ArrayBuffer;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > MAX_DOWNLOAD_BYTES) {
              await reader.cancel();
              throw new Error("File size exceeds maximum allowed limit of 5MB");
            }
            chunks.push(value);
          }
        }
      } catch (streamErr) {
        await reader.cancel().catch(() => {});
        throw streamErr;
      }
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      arrayBuffer = combined.buffer;
    } else {
      arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("File size exceeds maximum allowed limit of 5MB");
      }
    }

    // If dimension resizing is requested, process locally via sharp (no third-party proxy)
    if ((opts?.width || opts?.height) && typeof window === "undefined") {
      try {
        const sharpModule = await import("sharp");
        const sharp = (typeof sharpModule === "function"
          ? sharpModule
          : (sharpModule as { default?: typeof import("sharp") }).default ??
            sharpModule) as unknown as typeof import("sharp");
        const resizedBuffer = await sharp(Buffer.from(arrayBuffer))
          .resize({
            width: opts.width,
            height: opts.height,
            fit: "cover",
          })
          .toBuffer();
        return new Blob([resizedBuffer], {
          type: mimeType,
        });
      } catch (resizeErr) {
        console.warn(
          "[storage.urlToBlob] Local image resize failed, falling back to original blob",
          resizeErr,
        );
      }
    }

    return new Blob([arrayBuffer], {
      type: mimeType,
    });
  }

  private _getBucketName(bucket: BucketType) {
    if (bucket === "public") {
      const bucketName = this.publicBucket;

      if (!bucketName) {
        throw new Error("STORAGE_PUBLIC_BUCKET is not set");
      }

      return bucketName;
    }

    if (bucket === "private") {
      const bucketName = this.privateBucket;

      if (!bucketName) {
        throw new Error("STORAGE_PRIVATE_BUCKET is not set");
      }

      return bucketName;
    }

    throw new Error(`Invalid bucket type: ${bucket}`);
  }
}

export const storage = new StorageClient();

export const isStored = (url: string) => {
  return (
    (Boolean(storage.baseUrl) && url.startsWith(storage.baseUrl)) ||
    url.startsWith(R2_URL) ||
    url.startsWith(OG_AVATAR_URL)
  );
};

export const isNotHostedImage = (imageString: string) => {
  return !imageString.startsWith("https://");
};
