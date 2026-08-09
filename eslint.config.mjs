import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  {
    ignores: ["node_modules/**", "out/**", ".vite/**"],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      js,
    },
    extends: ["js/recommended"],
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "object-shorthand": ["error", "always"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: ["src/**/*.{js,jsx}"],
  },
  {
    files: ["src/main.js"],
    languageOptions: {
      globals: {
        MAIN_WINDOW_VITE_DEV_SERVER_URL: "readonly",
        MAIN_WINDOW_VITE_NAME: "readonly",
      },
    },
  },
  {
    files: ["src/components/ui/**/*.{js,jsx}"],
    rules: {
      curly: "off",
      eqeqeq: "off",
      "object-shorthand": "off",
    },
  },
]);
