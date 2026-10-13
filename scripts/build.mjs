import { copyFile, mkdir } from "node:fs/promises";

// OTM ships a standalone browser ESM artifact; no application bundler is needed.
const otm = new URL("../../", import.meta.resolve("on_the_money"));
const pico = new URL("./", import.meta.resolve("@picocss/pico/package.json"));
const vendor = new URL("../ai.plurnk/public/vendor/", import.meta.url);
const styles = new URL("../ai.plurnk/public/styles/", import.meta.url);
await mkdir(vendor, { recursive: true });
await mkdir(styles, { recursive: true });
await copyFile(new URL("dist/on_the_money.min.js", otm), new URL("otm.js", vendor));
await copyFile(new URL("LICENSE", otm), new URL("OTM-LICENSE.txt", vendor));
await copyFile(new URL("css/pico.classless.green.min.css", pico), new URL("app-vendor.css", styles));
await copyFile(new URL("LICENSE.md", pico), new URL("PICO-LICENSE.txt", vendor));
