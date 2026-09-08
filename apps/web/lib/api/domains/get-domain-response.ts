import { getApexDomain } from "@dub/utils";
import { isProxiedDomain } from "./utils";

export const getVercelDomainResponse = async (domain: string) => {
  if (!process.env.VERCEL_API_KEY && !process.env.AUTH_BEARER_TOKEN) {
    return {
      name: domain,
      apexName: getApexDomain(`https://${domain}`),
      projectId: process.env.VERCEL_PROJECT_ID || "local",
      verified: true,
    };
  }

  return await fetch(
    `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${domain.toLowerCase()}?teamId=${process.env.TEAM_ID_VERCEL}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_API_KEY || process.env.AUTH_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  ).then((res) => {
    return res.json();
  });
};

export const getDomainResponse = async (domain: string) => {
  if (isProxiedDomain(domain)) {
    return {
      verified: true,
    };
  }
  const apexDomain = getApexDomain(`https://${domain}`);
  if (apexDomain !== domain) {
    const wildcardDomain = `*.${apexDomain}`;
    const wildcardResponse = await getVercelDomainResponse(wildcardDomain);
    if (wildcardResponse.verified) {
      return wildcardResponse;
    }
  }
  return await getVercelDomainResponse(domain);
};
