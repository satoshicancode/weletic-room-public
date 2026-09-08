import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

export default function PointsExpiryReminder({
  brandName = "Yamax",
  logoUrl,
  accentColor,
  customerFirstName = "there",
  pointsBalance = "500 Points",
  expiryDate = "September 30, 2026",
  accountUrl = "https://example.myshopify.com/account",
  urgency = "warning",
}: {
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  customerFirstName?: string | null;
  pointsBalance: string;
  expiryDate: string;
  accountUrl: string;
  urgency: "warning" | "last_chance";
}) {
  const lastChance = urgency === "last_chance";

  return (
    <Html>
      <Head />
      <Preview>
        {lastChance ? "Last chance" : "Reminder"}: your {pointsBalance} expire
        on {expiryDate}
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
              {lastChance
                ? "Your points expire soon"
                : "Keep your loyalty points active"}
            </Heading>
            <Text className="text-sm leading-6 text-neutral-700">
              Hi {customerFirstName || "there"}, you currently have{" "}
              <strong>{pointsBalance}</strong>. They will expire on{" "}
              <strong>{expiryDate}</strong> unless you earn or redeem points
              before then.
            </Text>
            <Section className="my-7">
              <Link
                href={accountUrl}
                className="inline-block rounded-lg bg-black px-5 py-3 text-sm font-semibold text-white no-underline"
              >
                View rewards
              </Link>
            </Section>
            <Text className="text-xs leading-5 text-neutral-500">
              Any qualifying points activity resets your expiry date. You are
              receiving this reminder because you opted in to marketing from{" "}
              {brandName}.
            </Text>
            <Hr className="my-6 border-neutral-200" />
            <Text className="text-xs leading-5 text-neutral-500">
              You can review your customer profile and communication preferences
              from your store account.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
