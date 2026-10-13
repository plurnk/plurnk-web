import { readFile } from "node:fs/promises";
import { Knob } from "@plurnk/plurnk-meta";

/** @returns {import("@plurnk/plurnk-modules").DaemonModule<never, Pick<import("@plurnk/plurnk-contracts").ApplicationPort, "registerHttpRoute">>} */
export default function createModule() {
    if (!Knob.flag("PLURNK_WEB_ENABLED")) return {};

    return {
        mounts: ["/"],
        async start(seam) {
            // {§web-assets} Requests select entries, never filesystem paths.
            const resources = new Map(await Promise.all([
                ["/", "index.html", "text/html"],
                ["/app.js", "app.js", "text/javascript"],
                ["/vendor/otm.js", "vendor/otm.js", "text/javascript"],
                ["/vendor/app-vendor.css", "vendor/app-vendor.css", "text/css"],
                ["/locales/en.json", "locales/en.json", "application/json"],
                ["/vendor/OTM-LICENSE.txt", "vendor/OTM-LICENSE.txt", "text/plain"],
                ["/vendor/PICO-LICENSE.txt", "vendor/PICO-LICENSE.txt", "text/plain"],
            ].map(async ([pathname, file, mediaType]) => /** @type {const} */ ([
                pathname,
                { body: await readFile(new URL(`public/${file}`, import.meta.url)), mediaType, status: 200 },
            ]))));

            seam.registerHttpRoute("/", (req, res) => {
                const resource = resources.get((req.url ?? "").split("?")[0]);
                const supported = req.method === "GET" || req.method === "HEAD";
                const { status, body, mediaType } = !supported
                    ? { status: 405, body: Buffer.from("Method not allowed\n"), mediaType: "text/plain" }
                    : resource ?? { status: 404, body: Buffer.from("Not found\n"), mediaType: "text/plain" };
                res.writeHead(status, {
                    "content-type": `${mediaType}; charset=utf-8`,
                    "content-length": body.byteLength,
                    "x-content-type-options": "nosniff",
                    ...(status === 405 ? { allow: "GET, HEAD" } : {}),
                });
                res.end(req.method === "HEAD" ? undefined : body);
            });
        },
    };
}
