export const verifyDomain = async (domain: string) => {
  if (!process.env.VERCEL_API_KEY && !process.env.AUTH_BEARER_TOKEN) {
    return {
      name: domain,
      verified: true,
    };
  }

  return await fetch(
    `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${domain.toLowerCase()}/verify?teamId=${process.env.TEAM_ID_VERCEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_API_KEY || process.env.AUTH_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  ).then((res) => res.json());
};
