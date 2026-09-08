const path = require("node:path");

module.exports = {
  plugins: [
    require("tailwindcss")({
      content: [
        path.join(
          __dirname,
          "../../apps/web/ui/weletic/shoppers/**/*.{ts,tsx}",
        ),
        path.join(
          __dirname,
          "../../apps/web/ui/weletic/merchant-settings/**/*.{ts,tsx}",
        ),
        path.join(__dirname, "../../apps/web/ui/weletic/loyalty/**/*.{ts,tsx}"),
      ],
      important: ".weletic-shoppers",
      corePlugins: { preflight: false },
    }),
  ],
};
