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
  /^(?!.*(?:javascript|expression|behavior|vbscript|url\s*\(|image-set\s*\(|@import|-moz-binding)).*$/i,
];

const POSITION_STYLE_REGEX = [/^(?:static|relative|sticky)$/i];
const Z_INDEX_STYLE_REGEX = [/^(?:[0-9]|10)$/];

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
    div: ["style"],
    table: ["style"],
    thead: ["style"],
    tbody: ["style"],
    tr: ["style"],
    th: ["style", "colspan", "rowspan", "scope"],
    td: ["style", "colspan", "rowspan"],
    p: ["style"],
    span: ["style"],
    ul: ["style"],
    ol: ["style"],
    li: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    h5: ["style"],
    h6: ["style"],
    blockquote: ["style"],
    strong: ["style"],
    b: ["style"],
    em: ["style"],
    i: ["style"],
    u: ["style"],
    hr: ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  allowedStyles: {
    "*": Object.fromEntries(
      ALLOWED_CSS_PROPERTIES.map((prop) => {
        if (prop === "position") {
          return [prop, POSITION_STYLE_REGEX];
        }
        if (prop === "z-index") {
          return [prop, Z_INDEX_STYLE_REGEX];
        }
        return [prop, SAFE_STYLE_VALUE_REGEX];
      }),
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
