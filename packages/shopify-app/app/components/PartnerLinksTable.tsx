import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { LinkIcon } from "@shopify/polaris-icons";
import { useState } from "react";

export interface AffiliateLinkItem {
  id: string;
  url: string;
  destination: string;
  partnerName: string;
  clicks: number;
  leads: number;
  sales: string;
}

export function PartnerLinksTable({
  links,
  createLinkUrl,
}: {
  links: AffiliateLinkItem[];
  createLinkUrl: string | null;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (url: string, id: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const rows = links.map((link) => [
    <BlockStack key={link.id} gap="100">
      <Text as="span" variant="bodyMd" fontWeight="semibold">
        {link.url}
      </Text>
      <Text as="span" variant="bodyXs" tone="subdued">
        ↳ {link.destination}
      </Text>
    </BlockStack>,
    <Badge key={link.id} tone="info">
      {link.partnerName}
    </Badge>,
    <Text key={link.id} as="span" alignment="end">
      {link.clicks.toLocaleString()}
    </Text>,
    <Text key={link.id} as="span" alignment="end">
      {link.leads.toLocaleString()}
    </Text>,
    <Text key={link.id} as="span" alignment="end" fontWeight="bold">
      {link.sales}
    </Text>,
    <InlineStack key={link.id} align="end" gap="200">
      <Button size="micro" onClick={() => handleCopy(link.url, link.id)}>
        {copiedId === link.id ? "Copied!" : "Copy Link"}
      </Button>
    </InlineStack>,
  ]);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Active Affiliate Links
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Showing top converting affiliate links tracking sales for this
              store
            </Text>
          </BlockStack>
          <Button
            variant="primary"
            icon={LinkIcon as any}
            url={createLinkUrl ?? undefined}
            target={createLinkUrl ? "_blank" : undefined}
            disabled={!createLinkUrl}
          >
            Create Link
          </Button>
        </InlineStack>

        {links.length === 0 ? (
          <EmptyState
            heading="No affiliate links yet"
            action={{
              content: "Create Link",
              url: createLinkUrl ?? undefined,
              target: createLinkUrl ? "_blank" : undefined,
            }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              Create your first affiliate tracking link to start attributing
              partner sales and conversions.
            </p>
          </EmptyState>
        ) : (
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "numeric",
              "numeric",
              "numeric",
              "text",
            ]}
            headings={[
              "Link & Target",
              "Partner",
              "Clicks",
              "Leads",
              "Sales",
              "Actions",
            ]}
            rows={rows}
          />
        )}
      </BlockStack>
    </Card>
  );
}
