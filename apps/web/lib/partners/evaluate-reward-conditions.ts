import { prepareMetadataFieldValue } from "../api/rewards/reward-condition-metadata";
import {
  RewardCondition,
  RewardConditions,
  RewardConditionsArray,
  RewardContext,
} from "../types";
import { getRewardAmount } from "./get-reward-amount";

export const evaluateRewardConditions = ({
  conditions,
  context,
}: {
  conditions: RewardConditionsArray;
  context: RewardContext;
}) => {
  if (!conditions || !context) {
    return null;
  }

  const matchingConditions: RewardConditions[] = [];

  for (const conditionGroup of conditions) {
    // Evaluate each condition in the group
    const conditionResults = conditionGroup.conditions.map((condition) => {
      const fieldValue = resolveConditionFieldValue({ condition, context });

      if (fieldValue === undefined) {
        return false;
      }

      return evaluateCondition({
        condition,
        fieldValue,
      });
    });

    // Apply the operator logic to the condition results
    let conditionsMet = false;
    if (conditionGroup.operator === "AND") {
      conditionsMet = conditionResults.every((result) => result);
    } else if (conditionGroup.operator === "OR") {
      conditionsMet = conditionResults.some((result) => result);
    }

    if (conditionsMet) {
      matchingConditions.push(conditionGroup);
    }
  }

  if (matchingConditions.length === 0) {
    return null;
  }

  // Find the best matching condition (highest amount)
  return matchingConditions.sort(
    (a, b) =>
      getRewardAmount({
        type: b.type!,
        amountInCents: b.amountInCents,
        amountInPercentage: b.amountInPercentage,
      }) -
      getRewardAmount({
        type: a.type!,
        amountInCents: a.amountInCents,
        amountInPercentage: a.amountInPercentage,
      }),
  )[0];
};

function resolveConditionFieldValue({
  condition,
  context,
}: {
  condition: RewardCondition;
  context: RewardContext;
}): string | number | string[] | number[] | undefined {
  if (condition.attribute === "metadata") {
    const metaKey = condition.metadataField?.trim();

    if (!metaKey) {
      return undefined;
    }

    const entityMap = {
      partner: undefined,
      customer: undefined,
      lead: context.lead,
      sale: context.sale,
    } as const;

    return prepareMetadataFieldValue(
      entityMap[condition.entity]?.metadata?.[metaKey],
      condition,
    );
  }

  const entityMap = {
    partner: context.partner,
    customer: context.customer,
    lead: undefined,
    sale: context.sale,
  } as const;

  return entityMap[condition.entity]?.[condition.attribute];
}

const evaluateCondition = ({
  condition,
  fieldValue,
}: {
  condition: RewardCondition;
  fieldValue: string | number | string[] | number[];
}) => {
  const fieldArray = Array.isArray(fieldValue)
    ? (fieldValue as (string | number)[])
    : null;
  const conditionArray = Array.isArray(condition.value)
    ? (condition.value as (string | number)[])
    : null;

  // Equals
  if (condition.operator === "equals_to") {
    if (fieldArray) {
      if (conditionArray) {
        return conditionArray.some((v) =>
          fieldArray.some((item) => item === v),
        );
      }
      return fieldArray.some((item) => item === condition.value);
    }
    if (conditionArray) {
      return conditionArray.some((v) => v === fieldValue);
    }
    return fieldValue === condition.value;
  }

  // Not equals
  if (condition.operator === "not_equals") {
    if (fieldArray) {
      if (conditionArray) {
        return !conditionArray.some((v) =>
          fieldArray.some((item) => item === v),
        );
      }
      return !fieldArray.some((item) => item === condition.value);
    }
    if (conditionArray) {
      return !conditionArray.some((v) => v === fieldValue);
    }
    return fieldValue !== condition.value;
  }

  // Starts with
  if (condition.operator === "starts_with") {
    if (typeof condition.value !== "string" || condition.value === "") {
      return false;
    }

    if (fieldArray) {
      return fieldArray.some(
        (v) => typeof v === "string" && v.startsWith(condition.value as string),
      );
    }

    if (typeof fieldValue !== "string") {
      return false;
    }

    return fieldValue.startsWith(condition.value);
  }

  // Ends with
  if (condition.operator === "ends_with") {
    if (typeof condition.value !== "string" || condition.value === "") {
      return false;
    }

    if (fieldArray) {
      return fieldArray.some(
        (v) => typeof v === "string" && v.endsWith(condition.value as string),
      );
    }

    if (typeof fieldValue !== "string") {
      return false;
    }

    return fieldValue.endsWith(condition.value);
  }

  // Contains
  if (condition.operator === "contains") {
    if (typeof condition.value !== "string") {
      return false;
    }

    const trimmedValue = condition.value.trim();

    if (trimmedValue === "") {
      return false;
    }

    if (fieldArray) {
      return fieldArray.some(
        (v) =>
          typeof v === "string" &&
          (v.toLowerCase().includes(trimmedValue.toLowerCase()) ||
            v === trimmedValue),
      );
    }

    if (typeof fieldValue !== "string") {
      return false;
    }

    return String(fieldValue).includes(trimmedValue);
  }

  // Not contains
  if (condition.operator === "not_contains") {
    if (typeof condition.value !== "string") {
      return false;
    }

    const trimmedValue = condition.value.trim();

    if (trimmedValue === "") {
      return false;
    }

    if (fieldArray) {
      return !fieldArray.some(
        (v) =>
          typeof v === "string" &&
          (v.toLowerCase().includes(trimmedValue.toLowerCase()) ||
            v === trimmedValue),
      );
    }

    if (typeof fieldValue !== "string") {
      return false;
    }

    return !String(fieldValue).includes(trimmedValue);
  }

  // In
  if (condition.operator === "in") {
    if (!conditionArray) {
      return false;
    }

    if (fieldArray) {
      return conditionArray.some((v) => fieldArray.some((item) => item === v));
    }

    return conditionArray.some((v) => v === fieldValue);
  }

  // Not in
  if (condition.operator === "not_in") {
    if (!conditionArray || conditionArray.length === 0) {
      return false;
    }

    if (fieldArray) {
      return !conditionArray.some((v) => fieldArray.some((item) => item === v));
    }

    return !conditionArray.some((v) => v === fieldValue);
  }

  // Greater than
  if (condition.operator === "greater_than") {
    return Number(fieldValue) > Number(condition.value);
  }

  // Greater than or equal
  if (condition.operator === "greater_than_or_equal") {
    return Number(fieldValue) >= Number(condition.value);
  }

  // Less than
  if (condition.operator === "less_than") {
    return Number(fieldValue) < Number(condition.value);
  }

  // Less than or equal
  if (condition.operator === "less_than_or_equal") {
    return Number(fieldValue) <= Number(condition.value);
  }

  return false;
};
