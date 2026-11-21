import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";

/** {§web-session-observer} Cut real sockets without mocking or interpreting ACP bytes. */
export default async function disconnectProxy(target) {
    const targetUrl = new URL(target);
    /** @type {Set<import("node:stream").Duplex>} */
    const upgradedSockets = new Set();
    const dropUpgraded = () => {
        for (const sock of upgradedSockets) sock.destroy();
        upgradedSockets.clear();
    };
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
    server.on("upgrade", (req, clientSocket, head) => {
        const incoming = new URL(req.url ?? "/", target);
        const destination = new URL(`${incoming.pathname}${incoming.search}`, target);
        const upstream = request(destination, { method: req.method, headers: req.headers });
        upstream.on("upgrade", (res, upstreamSocket, upstreamHead) => {
            upgradedSockets.add(clientSocket);
            upgradedSockets.add(upstreamSocket);
            clientSocket.once("close", () => {
                upgradedSockets.delete(clientSocket);
                upstreamSocket.destroy();
            });
            upstreamSocket.once("close", () => {
                upgradedSockets.delete(upstreamSocket);
                clientSocket.destroy();
            });
            clientSocket.on("error", () => upstreamSocket.destroy());
            upstreamSocket.on("error", () => clientSocket.destroy());
            const headerLines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? "Switching Protocols"}`];
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
                headerLines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
            }
            clientSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
            if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
            if (head.length > 0) upstreamSocket.write(head);
            upstreamSocket.pipe(clientSocket);
            clientSocket.pipe(upstreamSocket);
        });
        upstream.on("response", (res) => {
            const headerLines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ""}`];
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
                headerLines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
            }
            clientSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
            res.pipe(clientSocket);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
        upstream.end();
    });
    server.on("connect", (_req, clientSocket, head) => {
        const upstreamSocket = connect(Number(targetUrl.port), targetUrl.hostname, () => {
            upgradedSockets.add(clientSocket);
            upgradedSockets.add(upstreamSocket);
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) upstreamSocket.write(head);
            upstreamSocket.pipe(clientSocket);
            clientSocket.pipe(upstreamSocket);
        });
        clientSocket.once("close", () => {
            upgradedSockets.delete(clientSocket);
            upstreamSocket.destroy();
        });
        upstreamSocket.once("close", () => {
            upgradedSockets.delete(upstreamSocket);
            clientSocket.destroy();
        });
        clientSocket.on("error", () => upstreamSocket.destroy());
        upstreamSocket.on("error", () => clientSocket.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        drop: () => {
            dropUpgraded();
            server.closeAllConnections();
        },
        async close() {
            const closed = once(server, "close");
            server.close();
            dropUpgraded();
            server.closeAllConnections();
            await closed;
        },
    };
}
