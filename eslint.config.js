import { defineConfig } from "eslint/config";
import otm from "on_the_money/eslint-config";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default defineConfig({
    files: ["web/**/*.js"],
    extends: [otm, noUnsanitized.configs.recommended],
});
