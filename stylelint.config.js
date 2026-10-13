import otm from "on_the_money/stylelint-config";

export default {
    extends: ["stylelint-config-standard"],
    ...otm,
    ignoreFiles: ["web/styles/app-vendor.css"],
};
