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
    const forwardHeaders = (headers) => {
        const rawHost = typeof headers.host === "string" ? headers.host.trim() : "";
        let nonLoopback = false;
        if (rawHost !== "") {
            try {
                const hostname = new URL(`http://${rawHost}`).hostname.toLowerCase();
                nonLoopback = hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]";
            } catch { /* ignore */ }
        }
        return nonLoopback
            ? { ...headers, "x-forwarded-proto": "http", "x-forwarded-host": rawHost }
            : headers;
    };
    const server = createServer((req, res) => {
        const incoming = new URL(req.url ?? "/", target);
        const destination = new URL(`${incoming.pathname}${incoming.search}`, target);
        const upstream = request(destination, { method: req.method, headers: forwardHeaders(req.headers) }, (response) => {
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
        const upstream = request(destination, { method: req.method, headers: forwardHeaders(req.headers) });
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
    server.on("connect", (req, clientSocket, head) => {
        const rawConnectHost = typeof req.url === "string" ? req.url.trim() : "";
        let nonLoopbackConnect = false;
        if (rawConnectHost !== "") {
            try {
                const hostname = new URL(`http://${rawConnectHost}`).hostname.toLowerCase();
                nonLoopbackConnect = hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]";
            } catch { /* ignore */ }
        }
        const upstreamSocket = connect(Number(targetUrl.port), targetUrl.hostname, () => {
            upgradedSockets.add(clientSocket);
            upgradedSockets.add(upstreamSocket);
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstreamSocket.pipe(clientSocket);
            if (!nonLoopbackConnect) {
                if (head.length > 0) upstreamSocket.write(head);
                clientSocket.pipe(upstreamSocket);
                return;
            }
            let pendingHeaderBytes = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
            let headersForwarded = false;
            const onChunk = (/** @type {Buffer} */ chunk) => {
                if (headersForwarded) {
                    upstreamSocket.write(chunk);
                    return;
                }
                pendingHeaderBytes = pendingHeaderBytes.length === 0 ? Buffer.from(chunk) : Buffer.concat([pendingHeaderBytes, chunk]);
                const boundary = pendingHeaderBytes.indexOf("\r\n\r\n");
                if (boundary === -1) return;
                headersForwarded = true;
                clientSocket.off("data", onChunk);
                const headPart = pendingHeaderBytes.subarray(0, boundary);
                const tailPart = pendingHeaderBytes.subarray(boundary + 4);
                const injected = Buffer.from(`\r\nX-Forwarded-Proto: http\r\nX-Forwarded-Host: ${rawConnectHost}\r\n\r\n`, "latin1");
                upstreamSocket.write(Buffer.concat([headPart, injected, tailPart]));
                clientSocket.pipe(upstreamSocket);
            };
            if (pendingHeaderBytes.length > 0) onChunk(Buffer.alloc(0));
            if (!headersForwarded) clientSocket.on("data", onChunk);
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
