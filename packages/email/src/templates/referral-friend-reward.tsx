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

export const referralConfirmationCopy = {
  en: {
    subject: "Your requested reward is ready",
    heading: "Your reward is ready",
    body: "Here is the one-time reward you requested:",
    code: "Discount code",
    action: "Use my reward",
    terms: "For one use by the email address that requested this reward.",
    expiry: "Expires (UTC):",
  },
  ja: {
    subject: "リクエストされた特典の準備ができました",
    heading: "特典の準備ができました",
    body: "リクエストされた一度限りの特典です：",
    code: "割引コード",
    action: "特典を利用する",
    terms: "この特典をリクエストしたメールアドレスで一度だけ利用できます。",
    expiry: "有効期限（UTC）：",
  },
  vi: {
    subject: "Phần thưởng bạn yêu cầu đã sẵn sàng",
    heading: "Phần thưởng đã sẵn sàng",
    body: "Đây là phần thưởng dùng một lần bạn đã yêu cầu:",
    code: "Mã giảm giá",
    action: "Sử dụng phần thưởng",
    terms: "Chỉ dùng một lần cho địa chỉ email đã yêu cầu phần thưởng này.",
    expiry: "Hết hạn (UTC):",
  },
};

export default function ReferralFriendReward({
  brandName = "Rewards Club",
  logoUrl,
  accentColor,
  locale = "en",
  rewardName = "Welcome reward",
  discountCode = "WELCOME",
  applyUrl = "https://example.myshopify.com/discount/WELCOME",
  expiresAt,
}: {
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  advocateName?: string | null;
  locale?: "en" | "ja" | "vi";
  rewardName: string;
  discountCode: string;
  applyUrl: string;
  expiresAt?: string | null;
}) {
  const copy = referralConfirmationCopy[locale];
  return (
    <React.Fragment>
      <Html lang={locale}>
        <Head />
        <Preview>{copy.subject}</Preview>
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
                {copy.heading}
              </Heading>
              <Text className="text-sm leading-6 text-neutral-700">
                {copy.body} <strong>{rewardName}</strong>
              </Text>
              <Section className="my-7 rounded-lg bg-neutral-100 px-5 py-4 text-center">
                <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {copy.code}
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
                  {copy.action}
                </Link>
              </Section>
              {expiresAt ? (
                <Text className="text-xs leading-5 text-neutral-500">
                  {copy.expiry} {expiresAt}. {copy.terms}
                </Text>
              ) : (
                <Text className="text-xs leading-5 text-neutral-500">
                  {copy.terms}
                </Text>
              )}
            </Container>
          </Body>
        </Tailwind>
      </Html>
    </React.Fragment>
  );
}
