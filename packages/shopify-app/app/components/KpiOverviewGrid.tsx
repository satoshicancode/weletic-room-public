import { BlockStack, Card, Icon, InlineGrid, Text } from "@shopify/polaris";
import {
  CashDollarIcon,
  DiscountIcon,
  OrderIcon,
  PersonIcon,
} from "@shopify/polaris-icons";

interface KpiStats {
  totalRevenue: string;
  totalOrders: number;
  activePartners: number;
  totalCommissions: string;
}

export function KpiOverviewGrid({
  stats = {
    totalRevenue: "$0.00",
    totalOrders: 0,
    activePartners: 0,
    totalCommissions: "$0.00",
  },
}: {
  stats?: KpiStats;
}) {
  const cards = [
    {
      title: "Affiliate Revenue",
      value: stats.totalRevenue,
      icon: CashDollarIcon,
      subtitle: "Gross sales tracked",
    },
    {
      title: "Partner Orders",
      value: stats.totalOrders.toLocaleString(),
      icon: OrderIcon,
      subtitle: "100% attributed",
    },
    {
      title: "Active Affiliates",
      value: stats.activePartners.toString(),
      icon: PersonIcon,
      subtitle: "Across all active groups",
    },
    {
      title: "Total Commissions",
      value: stats.totalCommissions,
      icon: DiscountIcon,
      subtitle: "Pending & settled",
    },
  ];

  return (
    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
      {cards.map((card) => (
        <Card key={card.title}>
          <BlockStack gap="200">
            <InlineGrid columns="1fr auto" alignItems="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {card.title}
              </Text>
              <Icon source={card.icon as any} tone="base" />
            </InlineGrid>
            <Text as="h3" variant="headingLg">
              {card.value}
            </Text>
            <Text as="p" variant="bodyXs" tone="success">
              {card.subtitle}
            </Text>
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
}
