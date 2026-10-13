const path = require("node:path");

module.exports = {
  plugins: [
    require("tailwindcss")({
      content: [
        path.join(__dirname, "app/**/*.{ts,tsx}"),
      ],
      important: ".weletic-shoppers",
      corePlugins: { preflight: false },
    }),
  ],
};
