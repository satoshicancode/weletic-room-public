import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import React from "react";

export default function ReferralFriendReward({
  brandName = "Rewards Club",
  logoUrl,
  accentColor,
  advocateName = "A friend",
  rewardName = "Welcome reward",
  discountCode = "WELCOME",
  applyUrl = "https://example.myshopify.com/discount/WELCOME",
  expiresAt,
}: {
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  advocateName?: string | null;
  rewardName: string;
  discountCode: string;
  applyUrl: string;
  expiresAt?: string | null;
}) {
  return (
    <React.Fragment>
      <Html>
        <Head />
        <Preview>
          {advocateName || "A friend"} sent you {rewardName} from {brandName}
        </Preview>
        <Tailwind>
          <Body className="mx-auto my-auto bg-neutral-100 font-sans">
            <Container
              className="mx-auto my-10 max-w-[560px] rounded-xl bg-white px-8 py-8"
              style={{
                borderTop: accentColor ? `4px solid ${accentColor}` : undefined,
              }}
            >
              {logoUrl && <Img src={logoUrl} alt={brandName} width={160} />}
              <Text className="m-0 text-sm font-semibold tracking-wide text-neutral-900">
                {brandName}
              </Text>
              <Heading className="mx-0 mb-4 mt-8 p-0 text-2xl font-semibold leading-8 text-neutral-900">
                Your friend reward is ready
              </Heading>
              <Text className="text-sm leading-6 text-neutral-700">
                {advocateName || "A friend"} invited you to shop with us. Use
                your one-time <strong>{rewardName}</strong> on your first order.
              </Text>
              <Section className="my-7 rounded-lg bg-neutral-100 px-5 py-4 text-center">
                <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Discount code
                </Text>
                <Text className="m-0 mt-2 font-mono text-2xl font-semibold tracking-wider text-neutral-900">
                  {discountCode}
                </Text>
              </Section>
              <Section className="my-7">
                <Link
                  href={applyUrl}
                  className="inline-block rounded-lg bg-black px-5 py-3 text-sm font-semibold text-white no-underline"
                >
                  Shop with my reward
                </Link>
              </Section>
              {expiresAt ? (
                <Text className="text-xs leading-5 text-neutral-500">
                  This reward expires on {expiresAt}. It can be used once and is
                  intended only for the email address that claimed it.
                </Text>
              ) : (
                <Text className="text-xs leading-5 text-neutral-500">
                  This reward can be used once and is intended only for the
                  email address that claimed it.
                </Text>
              )}
            </Container>
          </Body>
        </Tailwind>
      </Html>
    </React.Fragment>
  );
}
