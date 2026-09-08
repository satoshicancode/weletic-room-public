module.exports = {
  root: true,
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/playwright/**",
  ],
  overrides: [
    {
      files: ["packages/**/*.{ts,tsx}"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint", "react-hooks"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
      },
    },
  ],
};
