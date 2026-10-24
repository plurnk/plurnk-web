import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import otm from "on_the_money/eslint-config";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default defineConfig(
    { ignores: ["ai.plurnk/dist/**", "web/public/**", ".vite-test-*/**", ".module-test-*/**"] },
    {
        files: ["**/*.{js,mjs}"],
        extends: [js.configs.recommended],
        linterOptions: { reportUnusedDisableDirectives: "error" },
        rules: {
            "no-var": "error",
            "prefer-const": "error",
            "no-throw-literal": "error",
            "eqeqeq": ["error", "always", { null: "ignore" }],
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "all", ignoreRestSiblings: true }],
        },
    },
    {
        files: ["ai.plurnk/**/*.js", "scripts/**/*.mjs", "*.js"],
        languageOptions: { globals: globals.nodeBuiltin },
    },
    {
        // Browser callbacks execute in a page; their surrounding test executes in Node.
        files: ["test/**/*.js"],
        languageOptions: { globals: { ...globals.nodeBuiltin, ...globals.browser } },
    },
    {
        files: ["web/**/*.js"],
        languageOptions: { globals: globals.browser },
        extends: [otm, noUnsanitized.configs.recommended],
    },
    {
        files: ["web/**/*.js"],
        ignores: ["web/worker-agent.js"],
        rules: {
            "no-restricted-imports": ["error", { paths: [{
                name: "@plurnk/plurnk-acp/client",
                message: "Use worker-agent.js so schema security is initialized before the browser SDK.",
            }] }],
        },
    },
    {
        files: ["web/**/*.js", "ai.plurnk/**/*.js"],
        rules: {
            "no-restricted-syntax": ["error", {
                selector: "CallExpression[callee.type='Identifier'][callee.name=/^(setInterval|setTimeout)$/][arguments.1.type='Literal']",
                message: "Name the timer's mechanism or read its deployment setting through the configuration owner.",
            }],
        },
    },
);
