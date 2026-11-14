import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import Documents from "../src/documents.js";
import createModule from "../src/module.js";
import verifyRouteSettlement from "./route-settlement.js";

test("{§web-route-settlement} admitted route work precedes resource release", { timeout: 20_000 },
    (t) => verifyRouteSettlement(t, createModule));

test("{§web-route-settlement} module close drains admitted HTTP requests before closing asset sources", async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const order = [];
    let inFlight = 0;
    let assetsClosed = false;
    const documents = new Documents(
        '<head><link rel="stylesheet" href="/app.css"></head><title>Plurnk</title><header><template id="session-navigation"><a href="/account/">Account</a></template></header><main></main>',
        false,
        128,
    );
    const module = createModule({
        async setupStylesheet() { return "/app.css"; },
        async start() {},
        async snapshot() {
            inFlight++;
            entered.resolve(undefined);
            try {
                await release.promise;
                if (assetsClosed) throw new Error("assets closed while admitted request was still reading snapshot");
                return { documents, resources: new Map() };
            } finally {
                inFlight--;
                order.push("request.settled");
            }
        },
        async close() {
            assert.equal(inFlight, 0, "assets.close must run only after in-flight requests settle");
            assetsClosed = true;
            order.push("assets.closed");
        },
    });
    let handler;
    await module.setup({});
    await module.start(/** @type {any} */ ({
        readSessionOverview: async () => ({ workspaces: [], sessions: [] }),
        registerHttpRoute(_prefix, serve) { handler = serve; },
    }));
    const server = createServer((req, res) => { void handler(req, res); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const responsePromise = fetch(`http://127.0.0.1:${port}/`);
    await entered.promise;
    const closePromise = module.close();
    await setImmediate();
    assert.equal(assetsClosed, false, "assets remain open while admitted request is in flight");
    release.resolve(undefined);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    await closePromise;
    assert.deepEqual(order, ["request.settled", "assets.closed"]);
});
