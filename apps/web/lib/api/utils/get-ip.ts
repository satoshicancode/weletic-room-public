import { headers } from "next/headers";

export const getIP = async (customHeaders?: Headers) => {
  const FALLBACK_IP_ADDRESS = "0.0.0.0";
  const h = customHeaders ?? (await headers());

  // 1. Cloudflare connecting IP (overwritten and guaranteed by Cloudflare Edge)
  const cfConnectingIp = h.get("cf-connecting-ip");
  if (cfConnectingIp && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  // 2. Real IP from trusted reverse proxy
  const realIp = h.get("x-real-ip");
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  // 3. Rightmost IP in X-Forwarded-For to defeat client-spoofed leftmost headers
  const forwardedFor = h.get("x-forwarded-for");
  if (forwardedFor && forwardedFor.trim()) {
    const parts = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  return FALLBACK_IP_ADDRESS;
};
