import {
  loadFixture,
  loadInputQuery,
  loadSchema,
  validateTestAssets,
} from "@shopify/shopify-function-test-helpers";
import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

describe("Schema-backed Function fixtures", () => {
  let schema;
  let inputQueryAST;

  beforeAll(async () => {
    const functionDir = path.dirname(__dirname);
    schema = await loadSchema(path.join(functionDir, "schema.graphql"));
    inputQueryAST = await loadInputQuery(
      path.join(functionDir, "src/cart_lines_discounts_generate_run.graphql"),
    );
  });

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    test(`runs ${path.relative(fixturesDir, fixtureFile)}`, async () => {
      const fixture = await loadFixture(fixtureFile);

      const validationResult = await validateTestAssets({
        schema,
        fixture,
        inputQueryAST,
      });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);

      expect(cartLinesDiscountsGenerateRun(fixture.input)).toEqual(
        fixture.expectedOutput,
      );
    }, 10000);
  });
});
