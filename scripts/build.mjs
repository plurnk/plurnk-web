import { copyFile, mkdir } from "node:fs/promises";

// OTM ships a standalone browser ESM artifact; no application bundler is needed.
const otm = new URL("../../", import.meta.resolve("on_the_money"));
const vendor = new URL("../ai.plurnk/public/vendor/", import.meta.url);
await mkdir(vendor, { recursive: true });
await copyFile(new URL("dist/on_the_money.min.js", otm), new URL("otm.js", vendor));
await copyFile(new URL("LICENSE", otm), new URL("OTM-LICENSE.txt", vendor));
