import { readFile } from "node:fs/promises";
import { Knob } from "@plurnk/plurnk-meta";
import indexDocument from "./index-document.js";

/** @returns {import("@plurnk/plurnk-modules").DaemonModule<never, Pick<import("@plurnk/plurnk-contracts").ApplicationPort, "registerHttpRoute">>} */
export default function createModule() {
    if (!Knob.flag("PLURNK_WEB_ENABLED")) return {};

    return {
        mounts: ["/"],
        async start(seam) {
            // {§web-assets} Requests select entries, never filesystem paths.
            /** @type {[string, string, string][]} */
            const inventory = JSON.parse(await readFile(new URL("assets.json", import.meta.url), "utf8"));
            const resources = new Map(await Promise.all(inventory.map(async ([pathname, file, mediaType]) => /** @type {const} */ ([
                pathname,
                { body: await readFile(new URL(`dist/${file}`, import.meta.url)), mediaType, status: 200 },
            ]))));

            seam.registerHttpRoute("/", (req, res) => {
                const pathname = (req.url ?? "").split("?")[0];
                const resource = resources.get(indexDocument(pathname));
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
