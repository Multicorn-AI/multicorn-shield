import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      unicorn,
    },
    rules: {
      /* No any — enforced at lint level as well as tsconfig */
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      /* Prefer as-const objects over enums (per project standards) */
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "Use `as const` objects with type inference instead of enums for better tree-shaking and DX.",
        },
      ],

      /* Explicit return types on exported functions */
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],

      /* Named exports only */
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],

      /* Prefer readonly */
      "@typescript-eslint/prefer-readonly": "error",

      /* Consistent type imports */
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      /* No non-null assertions */
      "@typescript-eslint/no-non-null-assertion": "error",

      /* Unicorn rules for code quality */
      "unicorn/prefer-node-protocol": "error",
      "unicorn/no-array-for-each": "error",
      "unicorn/prefer-ternary": "error",
    },
  },
  {
    ignores: ["dist/", "coverage/", "node_modules/", "docs/", "*.config.*"],
  },
);
