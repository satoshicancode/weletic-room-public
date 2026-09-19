import { describe, expect, it } from "vitest";
import { shopperDatabaseTarget } from "../utils/shopper-database-target";
const url =
  "mysql://wr_012345abcdef:synthetic@127.0.0.1:3307/weletic_loyalty_it_shopper_012345abcdef";
describe("disposable shopper database guard", () => {
  it("requires a matching disposable database and principal", () => {
    expect(shopperDatabaseTarget(url, "1")).toEqual({
      name: "weletic_loyalty_it_shopper_012345abcdef",
      principal: "wr_012345abcdef@%",
    });
  });
  it.each([
    undefined,
    "invalid",
    url.replace("mysql:", "postgres:"),
    url.replace("127.0.0.1", "db.example.com"),
    url.replace("3307", "3306"),
    url.replace("wr_012345abcdef", "root"),
    url.replace("wr_012345abcdef", "wr_ffffffffffff"),
    url.replace(
      "/weletic_loyalty_it_shopper_012345abcdef",
      "/weletic_loyalty_dev",
    ),
    url.replace(":synthetic", ""),
    `${url}#unexpected`,
    `${url}?socket=/tmp/mysql.sock`,
    `${url}?connection_limit=999`,
    `${url}?connection_limit=2&connection_limit=3`,
  ])("rejects unsafe targets without echoing secrets", (value) => {
    expect(() => shopperDatabaseTarget(value, "1")).toThrow(
      "Refusing non-isolated shopper profile database",
    );
  });
  it.each([undefined, "0", "true"])("requires explicit opt-in: %s", (flag) => {
    expect(() => shopperDatabaseTarget(url, flag)).toThrow();
  });
});
