-- PR 5 stage 2: read-only integrity checks. Every finding count must be zero.
-- The application additionally NFC-normalizes SKU strings before persistence.
SELECT COUNT(*) AS invalid_bonus_campaign_sku_target_shapes
FROM `WeleticLoyaltyBonusCampaign`
WHERE `eligibleSkus` IS NOT NULL
  AND (
    JSON_TYPE(`eligibleSkus`) <> 'ARRAY'
    OR JSON_LENGTH(`eligibleSkus`) > 100
  );

SELECT COUNT(*) AS invalid_bonus_campaign_sku_target_values
FROM `WeleticLoyaltyBonusCampaign` AS campaign
JOIN JSON_TABLE(
  campaign.`eligibleSkus`,
  '$[*]' COLUMNS (`target` JSON PATH '$')
) AS sku
WHERE JSON_TYPE(campaign.`eligibleSkus`) = 'ARRAY'
  AND (
    JSON_TYPE(sku.`target`) <> 'STRING'
    OR CHAR_LENGTH(JSON_UNQUOTE(sku.`target`)) NOT BETWEEN 1 AND 255
    OR CHAR_LENGTH(JSON_UNQUOTE(sku.`target`)) <>
       CHAR_LENGTH(TRIM(JSON_UNQUOTE(sku.`target`)))
    OR JSON_UNQUOTE(sku.`target`) REGEXP '[[:cntrl:]]'
  );

SELECT COUNT(DISTINCT duplicate_campaigns.`id`)
  AS duplicate_bonus_campaign_sku_targets
FROM (
  SELECT campaign.`id`
  FROM `WeleticLoyaltyBonusCampaign` AS campaign
  JOIN JSON_TABLE(
    campaign.`eligibleSkus`,
    '$[*]' COLUMNS (`target` JSON PATH '$')
  ) AS sku
  WHERE JSON_TYPE(campaign.`eligibleSkus`) = 'ARRAY'
  GROUP BY campaign.`id`, CAST(JSON_UNQUOTE(sku.`target`) AS BINARY)
  HAVING COUNT(*) > 1
) AS duplicate_campaigns;

SELECT COUNT(*) AS invalid_bonus_campaign_collection_target_shapes
FROM `WeleticLoyaltyBonusCampaign`
WHERE `eligibleCollectionIds` IS NOT NULL
  AND (
    JSON_TYPE(`eligibleCollectionIds`) <> 'ARRAY'
    OR JSON_LENGTH(`eligibleCollectionIds`) > 100
  );

SELECT COUNT(*) AS invalid_bonus_campaign_collection_target_values
FROM `WeleticLoyaltyBonusCampaign` AS campaign
JOIN JSON_TABLE(
  campaign.`eligibleCollectionIds`,
  '$[*]' COLUMNS (`target` JSON PATH '$')
) AS collection_target
WHERE JSON_TYPE(campaign.`eligibleCollectionIds`) = 'ARRAY'
  AND (
    JSON_TYPE(collection_target.`target`) <> 'STRING'
    OR JSON_UNQUOTE(collection_target.`target`)
       NOT REGEXP '^gid://shopify/Collection/[1-9][0-9]*$'
  );

SELECT COUNT(DISTINCT duplicate_campaigns.`id`)
  AS duplicate_bonus_campaign_collection_targets
FROM (
  SELECT campaign.`id`
  FROM `WeleticLoyaltyBonusCampaign` AS campaign
  JOIN JSON_TABLE(
    campaign.`eligibleCollectionIds`,
    '$[*]' COLUMNS (`target` JSON PATH '$')
  ) AS collection_target
  WHERE JSON_TYPE(campaign.`eligibleCollectionIds`) = 'ARRAY'
  GROUP BY
    campaign.`id`,
    CAST(JSON_UNQUOTE(collection_target.`target`) AS BINARY)
  HAVING COUNT(*) > 1
) AS duplicate_campaigns;
