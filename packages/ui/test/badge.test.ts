import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, badgeVariants } from "../src/badge";

describe("badgeVariants", () => {
  it("generates default/neutral variant classes", () => {
    const classes = badgeVariants();
    expect(classes).toContain("border-neutral-400");
    expect(classes).toContain("text-neutral-500");
    expect(classes).toContain("rounded-full");
  });

  it("generates color variant classes", () => {
    expect(badgeVariants({ variant: "violet" })).toContain(
      "border-violet-600 bg-violet-600 text-white",
    );
    expect(badgeVariants({ variant: "blue" })).toContain(
      "border-blue-500 bg-blue-500 text-white",
    );
    expect(badgeVariants({ variant: "green" })).toContain(
      "border-green-200 bg-green-100 text-green-900",
    );
    expect(badgeVariants({ variant: "red" })).toContain(
      "border-red-100 bg-red-100 text-red-800",
    );
    expect(badgeVariants({ variant: "amber" })).toContain(
      "border-amber-200 bg-amber-100 text-amber-800",
    );
    expect(badgeVariants({ variant: "sky" })).toContain(
      "border-sky-900 bg-sky-900 text-white",
    );
    expect(badgeVariants({ variant: "black" })).toContain(
      "border-black bg-black text-white",
    );
    expect(badgeVariants({ variant: "rainbow" })).toContain(
      "bg-gradient-to-r from-violet-600 to-pink-600",
    );
  });

  it("merges custom className with variant classes", () => {
    const classes = badgeVariants({
      variant: "green",
      className: "extra-custom-class",
    });
    expect(classes).toContain("extra-custom-class");
    expect(classes).toContain("border-green-200");
  });
});

describe("Badge component rendering", () => {
  it("renders a span with appropriate HTML and children", () => {
    const html = renderToStaticMarkup(
      React.createElement(Badge, { variant: "violet" }, "VIP Member"),
    );

    expect(html).toContain("<span");
    expect(html).toContain("VIP Member");
    expect(html).toContain("border-violet-600");
    expect(html).toContain("bg-violet-600");
  });

  it("applies default neutral variant when variant is not specified", () => {
    const html = renderToStaticMarkup(
      React.createElement(Badge, null, "Standard"),
    );

    expect(html).toContain("border-neutral-400");
    expect(html).toContain("text-neutral-500");
    expect(html).toContain("Standard");
  });

  it("correctly includes additional custom class names", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Badge,
        { variant: "green", className: "shadow-md uppercase" },
        "Active",
      ),
    );

    expect(html).toContain("shadow-md uppercase");
    expect(html).toContain("Active");
  });
});
