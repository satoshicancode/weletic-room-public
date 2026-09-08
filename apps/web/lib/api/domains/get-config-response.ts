import { getApexDomain } from "@dub/utils";
import { isProxiedDomain } from "./utils";

const getVercelConfigResponse = async (domain: string) => {
  if (!process.env.VERCEL_API_KEY && !process.env.AUTH_BEARER_TOKEN) {
    return {
      configuredBy: "CNAME",
      acceptedChallenges: ["dns-01"],
      misconfigured: false,
      conflicts: [],
    };
  }

  return await fetch(
    `https://api.vercel.com/v6/domains/${domain.toLowerCase()}/config?teamId=${process.env.TEAM_ID_VERCEL}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_API_KEY || process.env.AUTH_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  ).then((res) => res.json());
};

export const getConfigResponse = async (domain: string) => {
  if (isProxiedDomain(domain)) {
    return {
      misconfigured: false,
      conflicts: [],
    };
  }
  const apexDomain = getApexDomain(`https://${domain}`);
  if (apexDomain !== domain) {
    const wildcardDomain = `*.${apexDomain}`;
    const wildcardResponse = await getVercelConfigResponse(wildcardDomain);
    if (!wildcardResponse.misconfigured) {
      return wildcardResponse;
    }
  }
  return await getVercelConfigResponse(domain);
};
