import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Text,
} from "@react-email/components";

/** All merchant/shopper content remains escaped React text, never HTML. */
export default function LoyaltyPointsEarned({
  brandName,
  logoUrl,
  accentColor,
  accountUrl,
  locale,
  content,
}: {
  brandName: string;
  logoUrl?: string | null;
  accentColor?: string | null;
  accountUrl: string;
  locale: "en" | "ja" | "vi";
  content: {
    subject: string;
    heading: string;
    body: string;
    actionLabel: string;
  };
}) {
  const footer = {
    en: "You receive loyalty updates because you opted in. Manage your communication preferences in your store account.",
    ja: "配信に同意された方にロイヤルティ情報をお送りしています。配信設定はストアのアカウントで変更できます。",
    vi: "Bạn nhận thông tin thành viên vì đã đồng ý nhận tin. Quản lý tùy chọn nhận tin trong tài khoản tại cửa hàng.",
  }[locale];
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{content.subject}</Preview>
      <Body
        style={{ backgroundColor: "#f5f5f5", fontFamily: "Arial, sans-serif" }}
      >
        <Container
          style={{
            backgroundColor: "#fff",
            padding: "24px",
            maxWidth: "560px",
          }}
        >
          {logoUrl ? (
            <Img src={logoUrl} alt={brandName} width="120" />
          ) : (
            <Text>{brandName}</Text>
          )}
          <Heading>{content.heading}</Heading>
          <Text style={{ whiteSpace: "pre-line" }}>{content.body}</Text>
          <Link href={accountUrl} style={{ color: accentColor || "#111111" }}>
            {content.actionLabel}
          </Link>
          <Text style={{ fontSize: "12px", color: "#666666" }}>{footer}</Text>
          <Link href={`${accountUrl}/profile`} style={{ fontSize: "12px" }}>
            {
              { en: "Preferences", ja: "配信設定", vi: "Tùy chọn nhận tin" }[
                locale
              ]
            }
          </Link>
        </Container>
      </Body>
    </Html>
  );
}
