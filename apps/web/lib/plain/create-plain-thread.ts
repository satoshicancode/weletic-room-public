import { CreateThreadInput } from "@team-plain/typescript-sdk";
import { plain, PlainUser } from "./client";
import { upsertPlainCustomer } from "./upsert-plain-customer";

export const createPlainThread = async ({
  user,
  ...rest
}: {
  user: PlainUser;
} & Omit<CreateThreadInput, "customerIdentifier">) => {
  if (!user.email) {
    throw new Error("User email is required");
  }

  const { data: upsertResult } = await upsertPlainCustomer({
    id: user.id,
    name: user.name,
    email: user.email,
  });

  if (!upsertResult) {
    throw new Error("Failed to upsert plain customer");
  }

  const customerId = upsertResult.customer.id;
  if (rest.externalId) {
    const { data: existing, error: lookupError } =
      await plain.getThreadByExternalId({
        customerId,
        externalId: rest.externalId,
      });
    if (lookupError) {
      throw new Error(
        `Failed to look up Plain thread by external id: ${lookupError.message}`,
      );
    }
    if (existing) return existing;
  }

  const { data, error } = await plain.createThread({
    customerIdentifier: {
      customerId,
    },
    ...rest,
  });

  if (error) {
    // A concurrent/retried request may have succeeded while the create result
    // was uncertain. The deterministic external id makes the provider lookup
    // authoritative and avoids duplicate compliance notifications.
    if (rest.externalId) {
      const { data: existing } = await plain.getThreadByExternalId({
        customerId,
        externalId: rest.externalId,
      });
      if (existing) return existing;
    }
    throw new Error(`Failed to create thread: ${error.message}`);
  }

  return data;
};
