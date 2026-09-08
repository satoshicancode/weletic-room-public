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

export function resolvePointsExpiryLocale(locale?: string | null) {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0];
  return language === "ja" || language === "vi" ? language : "en";
}

/** Plain text only: React escapes all merchant/shopper substitutions. */
export function getPointsExpiryCopy({
  locale,
  urgency,
  pointsBalance,
  expiryDate,
  customerFirstName,
  brandName,
}: {
  locale?: string | null;
  urgency: "warning" | "last_chance";
  pointsBalance: string;
  expiryDate: string;
  customerFirstName?: string | null;
  brandName: string;
}) {
  const language = resolvePointsExpiryLocale(locale);
  const lastChance = urgency === "last_chance";
  const name = customerFirstName?.trim();
  if (language === "ja") {
    return {
      language,
      subject: `${lastChance ? "最終のお知らせ：" : ""}${pointsBalance}の有効期限は${expiryDate}です`,
      heading: lastChance
        ? "ポイントの有効期限がまもなく切れます"
        : "ポイントの有効期限を延長しましょう",
      body: `${name ? `${name}様、` : "こんにちは。"}現在の残高は${pointsBalance}です。期限までに対象となるポイントの獲得または利用がない場合、${expiryDate}に失効します。`,
      action: "特典を見る",
      consent: `対象となるポイントの獲得・利用により有効期限が更新されます。このメールは、${brandName}からのマーケティング情報の受信に同意された方にお送りしています。`,
      preferences:
        "お客様情報とメールの受信設定は、ストアのアカウントから確認できます。",
    };
  }
  if (language === "vi") {
    return {
      language,
      subject: `${lastChance ? "Nhắc nhở lần cuối: " : ""}${pointsBalance} sẽ hết hạn vào ${expiryDate}`,
      heading: lastChance
        ? "Điểm của bạn sắp hết hạn"
        : "Duy trì hiệu lực điểm thành viên",
      body: `${name ? `Chào ${name},` : "Xin chào,"} bạn hiện có ${pointsBalance}. Số điểm này sẽ hết hạn vào ${expiryDate} nếu bạn không tích hoặc sử dụng điểm qua hoạt động đủ điều kiện trước thời hạn đó.`,
      action: "Xem phần thưởng",
      consent: `Hoạt động tích hoặc sử dụng điểm đủ điều kiện sẽ cập nhật ngày hết hạn. Bạn nhận được lời nhắc này vì đã đồng ý nhận thông tin tiếp thị từ ${brandName}.`,
      preferences:
        "Bạn có thể xem hồ sơ và tùy chọn nhận thông tin trong tài khoản tại cửa hàng.",
    };
  }
  return {
    language,
    subject: `${lastChance ? "Last chance: " : ""}${pointsBalance} expire on ${expiryDate}`,
    heading: lastChance
      ? "Your points expire soon"
      : "Keep your loyalty points active",
    body: `Hi ${name || "there"}, you currently have ${pointsBalance}. They will expire on ${expiryDate} unless you earn or redeem points through qualifying activity before then.`,
    action: "View rewards",
    consent: `Any qualifying points activity resets your expiry date. You are receiving this reminder because you opted in to marketing from ${brandName}.`,
    preferences:
      "You can review your customer profile and communication preferences from your store account.",
  };
}

export default function PointsExpiryReminder({
  brandName = "Yamax",
  logoUrl,
  accentColor,
  customerFirstName,
  pointsBalance = "500 Points",
  expiryDate = "September 30, 2026",
  accountUrl = "https://example.myshopify.com/account",
  urgency = "warning",
  locale = "en",
}: {
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  customerFirstName?: string | null;
  pointsBalance: string;
  expiryDate: string;
  accountUrl: string;
  urgency: "warning" | "last_chance";
  locale?: string | null;
}) {
  const copy = getPointsExpiryCopy({
    locale,
    urgency,
    pointsBalance,
    expiryDate,
    customerFirstName,
    brandName,
  });

  return (
    <Html lang={copy.language}>
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
              {copy.body}
            </Text>
            <Section className="my-7">
              <Link
                href={accountUrl}
                className="inline-block rounded-lg bg-black px-5 py-3 text-sm font-semibold text-white no-underline"
              >
                {copy.action}
              </Link>
            </Section>
            <Text className="text-xs leading-5 text-neutral-500">
              {copy.consent}
            </Text>
            <Hr className="my-6 border-neutral-200" />
            <Text className="text-xs leading-5 text-neutral-500">
              {copy.preferences}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
