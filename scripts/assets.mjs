import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

// Browser dependencies are bundled by Vite; licenses remain public static assets.
const otm = new URL("../../", import.meta.resolve("on_the_money"));
const pico = new URL("./", import.meta.resolve("@picocss/pico/package.json"));
const vendor = new URL("../web/public/vendor/", import.meta.url);
const styles = new URL("../web/styles/", import.meta.url);
await mkdir(vendor, { recursive: true });
await mkdir(styles, { recursive: true });
await copyFile(new URL("LICENSE", otm), new URL("OTM-LICENSE.txt", vendor));
await copyFile(new URL("css/pico.classless.green.min.css", pico), new URL("app-vendor.css", styles));
await copyFile(new URL("LICENSE.md", pico), new URL("PICO-LICENSE.txt", vendor));

const icons = new URL("../web/public/icons/", import.meta.url);
const artwork = await readFile(new URL("plurnk.svg", icons), "utf8");
for (const size of [16, 32, 180, 192, 512]) {
    const image = new Resvg(artwork, {
        fitTo: { mode: "width", value: size },
        ...(size === 180 ? { background: "#ffffff" } : {}),
    });
    await writeFile(new URL(`plurnk-${size}.png`, icons), image.render().asPng());
}
// {§web-installation} Keep all meaningful artwork within the maskable safe circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#ffffff"/><g transform="translate(19.2 19.2) scale(0.7)">${artwork}</g></svg>`;
await writeFile(new URL("plurnk-maskable-512.png", icons),
    new Resvg(maskable, { fitTo: { mode: "width", value: 512 } }).render().asPng());
