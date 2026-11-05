// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Architecture rules A1, A2 and A6 from docs/架构评审与发展规划-2026-10-20.md §2.5.
 * The 2.x governance kernel now lives under src/gate and stays frozen.
 * config, entry, security, contracts, cli.ts and mcp-server.ts are still the
 * unsplit 2.x shape. The exemption stays until they are split out or stop violating the size rules.
 * Size limits apply in full to new code under src/core, src/hosts, src/io and src/app.
 */
const FROZEN_KERNEL = [
  "src/gate/**",
  "src/config/**",
  "src/entry/**",
  "src/security/**",
  "src/contracts/**",
  "src/cli.ts",
  "src/mcp-server.ts"
];

/** Node globals for the ESM/CJS scripts and config files that are not type-checked. */
const NODE_GLOBALS = { process: "readonly", console: "readonly", Buffer: "readonly", module: "writable", require: "readonly", __dirname: "readonly", URL: "readonly", setTimeout: "readonly", clearTimeout: "readonly" };

/**
 * Legacy findings in the frozen kernel, tests and release scripts are reported
 * as warnings so they stay visible without blocking; new code under
 * src/core, src/hosts, src/io and src/app gets the full error set.
 */
const LEGACY_WARNINGS = {
  "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  "no-useless-catch": "warn",
  "no-useless-assignment": "warn",
  "prefer-const": "warn",
  "preserve-caught-error": "warn"
};

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "output/**", ".archify/**", "release-artifacts/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The product deliberately rejects NUL/CR/LF and other control characters in
    // paths and identifiers; those regexes are intentional.
    rules: { "no-control-regex": "off" }
  },
  { files: ["scripts/**/*.mjs", "*.cjs", "*.js"], languageOptions: { globals: NODE_GLOBALS }, rules: LEGACY_WARNINGS },
  {
    files: ["src/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 4],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement > NewExpression[callee.name='Error']",
          message: "Throw StinkyCobblerError with a registered code instead of a bare Error."
        }
      ]
    }
  },
  {
    files: FROZEN_KERNEL,
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-depth": "off",
      "no-restricted-syntax": "off",
      ...LEGACY_WARNINGS
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      ...LEGACY_WARNINGS
    }
  }
);
