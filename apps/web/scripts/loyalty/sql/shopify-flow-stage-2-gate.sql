-- PR 6 stage 2: read-only integrity checks. Every finding count must be zero.
SELECT COUNT(*) AS invalid_flow_definition_ids
FROM `WeleticShopifyFlowTriggerState`
WHERE TRIM(`triggerDefinitionId`) = '';

SELECT COUNT(*) AS invalid_flow_shop_ids
FROM `WeleticShopifyFlowTriggerState`
WHERE `shopifyStoreId` NOT REGEXP '^[1-9][0-9]{0,19}$';

SELECT COUNT(*) AS orphaned_flow_states
FROM `WeleticShopifyFlowTriggerState` flow_state
LEFT JOIN `WeleticShopifyStore` store_row ON store_row.`id` = flow_state.`storeId`
WHERE store_row.`id` IS NULL;

SELECT COUNT(*) AS invalid_flow_outbox_payloads
FROM `WeleticLoyaltyOutboxJob`
WHERE `jobType` = 'FLOW_TRIGGER'
  AND (
    JSON_TYPE(`payload`) <> 'OBJECT'
    OR JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.accountId')) IS NULL
    OR JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.handle')) NOT IN (
      'weletic-points-earned',
      'weletic-vip-tier-changed',
      'weletic-reward-redeemed',
      'weletic-points-expiring-soon'
    )
  );
