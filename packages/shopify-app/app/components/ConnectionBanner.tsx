import { Badge, Banner, Box, InlineStack, Text } from "@shopify/polaris";

interface ConnectionBannerProps {
  workspaceName: string | null;
  isConnected: boolean;
  connectUrl: string | null;
  dashboardUrl: string | null;
}

export function ConnectionBanner({
  workspaceName,
  isConnected,
  connectUrl,
  dashboardUrl,
}: ConnectionBannerProps) {
  if (!isConnected) {
    return (
      <Banner
        title="Connect your Weletic Workspace"
        tone="warning"
        action={
          connectUrl
            ? {
                content: "Connect Weletic",
                url: connectUrl,
                target: "_blank",
              }
            : undefined
        }
      >
        <p>
          Connect your Shopify store with your Weletic partner program to
          automatically sync products, track sales conversions, and reward
          affiliates.
        </p>
      </Banner>
    );
  }

  return (
    <Box paddingBlockEnd="400">
      <Banner
        tone="success"
        action={
          dashboardUrl
            ? {
                content: "Open Weletic Dashboard",
                url: dashboardUrl,
                target: "_blank",
              }
            : undefined
        }
      >
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text variant="bodyMd" as="span">
              Connected to Weletic workspace:
            </Text>
            <Text variant="headingSm" as="strong">
              {workspaceName ?? "Weletic"}
            </Text>
            <Badge tone="success">Active</Badge>
          </InlineStack>
        </InlineStack>
      </Banner>
    </Box>
  );
}
