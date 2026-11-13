import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Browser dependencies are bundled by Vite; licenses remain public static assets.
 * @param {URL} [webRoot]
 */
export default async function prepareAssets(webRoot = new URL("../web/", import.meta.url)) {
    const otm = new URL("../../", import.meta.resolve("on_the_money"));
    const pico = new URL("./", import.meta.resolve("@picocss/pico/package.json"));
    const vendor = new URL("./public/vendor/", webRoot);
    const styles = new URL("./styles/", webRoot);
    await mkdir(vendor, { recursive: true });
    await mkdir(styles, { recursive: true });
    await copyFile(new URL("LICENSE", otm), new URL("OTM-LICENSE.txt", vendor));
    await copyFile(new URL("css/pico.classless.green.css", pico), new URL("app-vendor.css", styles));
    await copyFile(new URL("LICENSE.md", pico), new URL("PICO-LICENSE.txt", vendor));

    const icons = new URL("./public/icons/", webRoot);
    const artwork = await readFile(new URL("plurnk.svg", icons), "utf8");
    // {§web-installation} Keep all meaningful artwork within the maskable safe circle.
    const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#ffffff"/><g transform="translate(19.2 19.2) scale(0.7)">${artwork}</g></svg>`;
    await writeFile(new URL("plurnk-maskable.svg", icons), maskable);
}

if (import.meta.main) await prepareAssets();
