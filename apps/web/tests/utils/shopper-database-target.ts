/** Only accept a disposable shopper-suite database and its matching principal.
 * Never fall back to the retained development database or print credentials.
 */
export function shopperDatabaseTarget(
  urlValue: string | undefined,
  enabled: string | undefined,
) {
  try {
    const url = new URL(urlValue ?? "invalid:");
    const suffix = /^\/weletic_loyalty_it_shopper_([a-f0-9]{12})$/.exec(
      url.pathname,
    )?.[1];
    if (
      enabled !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      !suffix ||
      url.username !== `wr_${suffix}` ||
      !url.password ||
      url.hash ||
      [...url.searchParams].some(
        ([key, value]) =>
          key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
      ) ||
      url.searchParams.getAll("connection_limit").length > 1
    )
      throw new Error();
    return { name: url.pathname.slice(1), principal: `${url.username}@%` };
  } catch {
    throw new Error("Refusing non-isolated shopper profile database");
  }
}
