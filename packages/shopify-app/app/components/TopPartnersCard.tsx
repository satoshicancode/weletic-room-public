import {
  Avatar,
  Badge,
  BlockStack,
  Card,
  InlineStack,
  ResourceItem,
  ResourceList,
  Text,
} from "@shopify/polaris";

export interface PartnerLeaderboardItem {
  id: string;
  name: string;
  tier: string;
  totalSales: string;
  conversionRate: string;
}

export function TopPartnersCard({
  partners = [],
}: {
  partners?: PartnerLeaderboardItem[];
}) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Top Performing Affiliates
        </Text>
        {partners.length === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            No partner sales recorded yet. Once your active affiliates generate
            conversions, they will appear here.
          </Text>
        ) : (
          <ResourceList
            resourceName={{ singular: "partner", plural: "partners" }}
            items={partners}
            renderItem={(item) => (
              <ResourceItem
                id={item.id}
                key={item.id}
                onClick={() => {}}
                accessibilityLabel={`View details for ${item.name}`}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Avatar customer size="md" name={item.name} />
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {item.name}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <BlockStack gap="050" inlineAlign="end">
                    <Badge tone="success">{item.tier}</Badge>
                    <Text as="span" variant="bodySm" fontWeight="bold">
                      {item.totalSales}
                    </Text>
                    <Text as="span" variant="bodyXs" tone="subdued">
                      Conv: {item.conversionRate}
                    </Text>
                  </BlockStack>
                </InlineStack>
              </ResourceItem>
            )}
          />
        )}
      </BlockStack>
    </Card>
  );
}
