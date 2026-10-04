import sanitizeHtml from "sanitize-html";

export const ALLOWED_PRODUCT_DESCRIPTION_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "span",
  "ul",
  "ol",
  "li",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
] as const;

const SAFE_STYLE_VALUE_REGEX = [
  /^(?!.*(?:javascript|expression|behavior|vbscript|url\s*\(|@import|-moz-binding)).*$/i,
];

export const ALLOWED_CSS_PROPERTIES = [
  // Layout & Box model
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow",
  "overflow-x",
  "overflow-y",
  "display",
  "box-sizing",
  // Positioning (Yamax responsive sticky table columns)
  "position",
  "left",
  "right",
  "top",
  "bottom",
  "z-index",
  // Table formatting
  "border-collapse",
  "border-spacing",
  "vertical-align",
  "text-align",
  // Typography
  "font-size",
  "font-weight",
  "font-style",
  "font-family",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "text-transform",
  "white-space",
  "word-break",
  // Colors & Backgrounds
  "color",
  "background-color",
  "background",
  // Borders
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  // Flexbox
  "flex",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "gap",
] as const;

export const PRODUCT_DESCRIPTION_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_PRODUCT_DESCRIPTION_TAGS],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    div: ["style", "class"],
    table: ["style", "class"],
    thead: ["style", "class"],
    tbody: ["style", "class"],
    tr: ["style", "class"],
    th: ["style", "class", "colspan", "rowspan", "scope"],
    td: ["style", "class", "colspan", "rowspan"],
    p: ["style", "class"],
    span: ["style", "class"],
    ul: ["style", "class"],
    ol: ["style", "class"],
    li: ["style", "class"],
    h1: ["style", "class"],
    h2: ["style", "class"],
    h3: ["style", "class"],
    h4: ["style", "class"],
    h5: ["style", "class"],
    h6: ["style", "class"],
    blockquote: ["style", "class"],
    strong: ["style", "class"],
    b: ["style", "class"],
    em: ["style", "class"],
    i: ["style", "class"],
    u: ["style", "class"],
    hr: ["style", "class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  allowedStyles: {
    "*": Object.fromEntries(
      ALLOWED_CSS_PROPERTIES.map((prop) => [prop, SAFE_STYLE_VALUE_REGEX]),
    ),
  },
  transformTags: {
    a: (tagName, attribs) => {
      const existingRel = attribs.rel
        ? attribs.rel.split(/\s+/).filter(Boolean)
        : [];
      const relSet = new Set(existingRel);
      relSet.add("noopener");
      relSet.add("noreferrer");
      return {
        tagName: "a",
        attribs: {
          ...attribs,
          rel: Array.from(relSet).join(" "),
        },
      };
    },
  },
};

/**
 * Sanitizes product description HTML to protect partner dashboard and APIs against stored XSS,
 * while preserving standard Yamax activewear formatting and responsive table styles.
 *
 * @param dirtyHtml Raw HTML string from Shopify catalog / translation
 * @returns Cleaned HTML string safe for DOM rendering
 */
export function sanitizeProductDescriptionHtml(
  dirtyHtml: string | null | undefined,
): string {
  if (!dirtyHtml || typeof dirtyHtml !== "string" || dirtyHtml.trim() === "") {
    return "";
  }

  return sanitizeHtml(dirtyHtml, PRODUCT_DESCRIPTION_SANITIZE_OPTIONS);
}
