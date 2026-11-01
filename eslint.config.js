import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "demo/fixtures/**", "agent-tools/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["bin/**/*.js", "demo/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
);
