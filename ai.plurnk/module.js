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
                ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
                ["/icons/plurnk.svg", "icons/plurnk.svg", "image/svg+xml"],
                ...[16, 32, 180, 192, 512].map((size) => [`/icons/plurnk-${size}.png`, `icons/plurnk-${size}.png`, "image/png"]),
                ["/icons/plurnk-maskable-512.png", "icons/plurnk-maskable-512.png", "image/png"],
                ["/icons/NOTO-NOTICE.txt", "icons/NOTO-NOTICE.txt", "text/plain"],
                ["/icons/APACHE-2.0.txt", "icons/APACHE-2.0.txt", "text/plain"],
                ["/app.js", "app.js", "text/javascript"],
                ["/vendor/otm.js", "vendor/otm.js", "text/javascript"],
                ["/styles/app-vendor.css", "styles/app-vendor.css", "text/css"],
                ["/styles/app-structure.css", "styles/app-structure.css", "text/css"],
                ["/styles/app-style.css", "styles/app-style.css", "text/css"],
                ["/styles/app-state.css", "styles/app-state.css", "text/css"],
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
                    "content-type": mediaType.startsWith("image/") ? mediaType : `${mediaType}; charset=utf-8`,
                    "content-length": body.byteLength,
                    "x-content-type-options": "nosniff",
                    ...(status === 405 ? { allow: "GET, HEAD" } : {}),
                });
                res.end(req.method === "HEAD" ? undefined : body);
            });
        },
    };
}
