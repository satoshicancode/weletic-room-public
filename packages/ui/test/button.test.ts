import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "../src/button";

describe("buttonVariants", () => {
  it("generates default primary variant classes", () => {
    const classes = buttonVariants();
    expect(classes).toContain("border-black bg-black");
    expect(classes).toContain("text-content-inverted");
  });

  it("generates secondary, outline, and colored variants", () => {
    expect(buttonVariants({ variant: "secondary" })).toContain(
      "border-border-subtle",
    );
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-bg-default");

    expect(buttonVariants({ variant: "outline" })).toContain(
      "border-transparent",
    );
    expect(buttonVariants({ variant: "outline" })).toContain(
      "text-content-default",
    );

    expect(buttonVariants({ variant: "success" })).toContain(
      "border-blue-500 bg-blue-500 text-white",
    );
    expect(buttonVariants({ variant: "danger" })).toContain(
      "border-red-500 bg-red-500 text-white",
    );
    expect(buttonVariants({ variant: "danger-outline" })).toContain(
      "border-transparent bg-white text-red-500",
    );
  });

  it("appends custom className to variant styles", () => {
    const classes = buttonVariants({
      variant: "danger",
      className: "w-full my-4",
    });
    expect(classes).toContain("w-full my-4");
    expect(classes).toContain("border-red-500");
  });
});

describe("Button component rendering", () => {
  it("renders a button element with type submit by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(Button, { text: "Save" }),
    );

    expect(html).toContain("<button");
    expect(html).toContain('type="submit"');
    expect(html).toContain("Save");
    expect(html).toContain("border-black bg-black");
  });

  it("renders type button when onClick handler is present", () => {
    const html = renderToStaticMarkup(
      React.createElement(Button, { text: "Cancel", onClick: () => {} }),
    );

    expect(html).toContain('type="button"');
    expect(html).toContain("Cancel");
  });

  it("handles disabled and loading states correctly", () => {
    const disabledHtml = renderToStaticMarkup(
      React.createElement(Button, { text: "Disabled Action", disabled: true }),
    );
    expect(disabledHtml).toContain("disabled");
    expect(disabledHtml).toContain("cursor-not-allowed");

    const loadingHtml = renderToStaticMarkup(
      React.createElement(Button, { text: "Loading Action", loading: true }),
    );
    expect(loadingHtml).toContain("disabled");
    expect(loadingHtml).toContain("animate-spin");
  });

  it("renders shortcut tag when provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(Button, { text: "Search", shortcut: "⌘K" }),
    );
    expect(html).toContain("<kbd");
    expect(html).toContain("⌘K");
  });
});
