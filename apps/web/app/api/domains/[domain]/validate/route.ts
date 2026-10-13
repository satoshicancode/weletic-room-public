import { isValidDomain } from "@/lib/api/domains/is-valid-domain";
import { domainExists } from "@/lib/api/domains/utils";
import { validateDubLinkSubdomain } from "@/lib/api/domains/validate-dub-link-subdomain";
import { withSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { hasSiteConfigured } from "./utils";

// GET /api/domains/[domain]/validate – check if a domain is valid
export const GET = withSession(async ({ params }) => {
  const { domain } = params;
  const validDomain = isValidDomain(domain);
  if (!validDomain) {
    return NextResponse.json({
      status: "invalid",
    });
  }
  if (domain.startsWith("www.")) {
    return NextResponse.json({
      status: "invalid",
      message: "Custom domain cannot start with www.",
    });
  }
  const dubLinkError = validateDubLinkSubdomain(domain);
  if (dubLinkError) {
    return NextResponse.json({
      status: "invalid",
      message: dubLinkError.error,
    });
  }
  const exists = await domainExists(domain);
  if (exists) {
    return NextResponse.json({
      status: "conflict",
    });
  }
  // skip site check for .dub.link subdomains
  if (!domain.endsWith(".dub.link")) {
    const hasSite = await hasSiteConfigured(domain);
    if (hasSite) {
      return NextResponse.json({
        status: "has site",
      });
    }
  }
  return NextResponse.json({
    status: "available",
  });
});
