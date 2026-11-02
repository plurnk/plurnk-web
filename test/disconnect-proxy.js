import { once } from "node:events";
import { createServer, request } from "node:http";

/** {§web-session-observer} Cut real sockets without mocking or interpreting ACP bytes. */
export default async function disconnectProxy(target) {
    const server = createServer((req, res) => {
        const incoming = new URL(req.url ?? "/", target);
        const destination = new URL(`${incoming.pathname}${incoming.search}`, target);
        const upstream = request(destination, { method: req.method, headers: req.headers }, (response) => {
            res.writeHead(response.statusCode, response.headers);
            res.flushHeaders();
            response.on("error", (error) => res.destroy(error));
            response.pipe(res);
        });
        upstream.on("error", (error) => res.destroy(error));
        res.once("close", () => upstream.destroy());
        req.pipe(upstream);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        drop: () => server.closeAllConnections(),
        async close() {
            const closed = once(server, "close");
            server.close();
            server.closeAllConnections();
            await closed;
        },
    };
}
