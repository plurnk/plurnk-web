import otm from "on_the_money/stylelint-config";

export default {
    extends: ["stylelint-config-standard"],
    ...otm,
    ignoreFiles: ["ai.plurnk/public/styles/app-vendor.css"],
};
