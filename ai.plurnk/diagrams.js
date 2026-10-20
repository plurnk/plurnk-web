import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { Piscina } from "piscina";
import { MIMEType } from "node:util";
import { privateHeaders, RequestError } from "./http.js";

// Node timers use a signed 32-bit millisecond delay; overflow becomes a 1 ms timer.
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** {§web-diagram-service} Owns bounded presentation work, never daemon agent work. */
export default class Diagrams {
    #threads = Knob.integer("PLURNK_WEB_DIAGRAM_THREADS", 1);
    #pending = Knob.integer("PLURNK_WEB_DIAGRAM_PENDING", 1);
    #timeout = Knob.integer("PLURNK_WEB_DIAGRAM_TIMEOUT_MS", 1);
    #input = Knob.integer("PLURNK_WEB_DIAGRAM_INPUT_BYTES", 1);
    #output = Knob.integer("PLURNK_WEB_DIAGRAM_OUTPUT_BYTES", 1);
    #edges = Knob.integer("PLURNK_WEB_DIAGRAM_EDGES", 1);
    /** @type {Piscina<Parameters<typeof import("./diagram-compiler.js").default>[0], ReturnType<typeof import("./diagram-compiler.js").default>> | undefined} */
    #pool;
    #active = 0;
    #stop = new AbortController();

    constructor() {
        if (this.#timeout > MAX_TIMER_DELAY) {
            throw new ConfigurationError("PLURNK_WEB_DIAGRAM_TIMEOUT_MS", `must not exceed ${MAX_TIMER_DELAY} milliseconds`);
        }
    }

    /** @param {string} source @param {AbortSignal} signal */
    async #compile(source, signal) {
        if (this.#stop.signal.aborted) throw new RequestError(503, "Diagram service is stopping.");
        if (this.#active >= this.#pending) throw new RequestError(429, "Diagram service is busy.");
        const deadline = AbortSignal.timeout(this.#timeout);
        const combined = AbortSignal.any([signal, deadline, this.#stop.signal]);
        this.#pool ??= new Piscina({ filename: new URL("./diagram-compiler.js", import.meta.url).href,
            minThreads: 0, maxThreads: this.#threads, maxQueue: this.#pending });
        this.#active++;
        try {
            const result = await this.#pool.run({ source, limit: this.#input, outputLimit: this.#output, maxEdges: this.#edges }, { signal: combined });
            if (result.error !== undefined) throw new RequestError(422, result.error);
            return Buffer.from(result.svg);
        } catch (cause) {
            if (this.#stop.signal.aborted) throw new RequestError(503, "Diagram service is stopping.", { cause });
            if (deadline.aborted) throw new RequestError(408, "Diagram rendering timed out.", { cause });
            throw cause;
        } finally { this.#active--; }
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    async serve(req, res) {
        if (req.method !== "POST") {
            res.setHeader("allow", "POST");
            throw new RequestError(405, "Use POST for diagram compilation.");
        }
        // JSON is not CORS-safelisted: cross-origin forms cannot invoke the compiler.
        let type;
        try { type = new MIMEType(req.headers["content-type"] ?? ""); }
        catch (cause) { throw new RequestError(415, "Use UTF-8 application/json.", { cause }); }
        if (type.essence !== "application/json" || (type.params.has("charset") && type.params.get("charset")?.toLowerCase() !== "utf-8")) {
            throw new RequestError(415, "Use UTF-8 application/json.");
        }
        if (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") {
            throw new RequestError(403, "Same-origin request required.");
        }
        const disconnected = new AbortController();
        const depart = () => disconnected.abort();
        res.once("close", depart);
        try {
            let size = 0;
            const chunks = [];
            for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                size += chunk.byteLength;
                if (size > this.#input) throw new RequestError(413, "Diagram source exceeds the configured limit.");
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
            catch (cause) { throw new RequestError(400, "Invalid diagram JSON.", { cause }); }
            if (input === null || typeof input !== "object" || Array.isArray(input)
                || typeof input.source !== "string" || Object.keys(input).length !== 1) {
                throw new RequestError(400, "Expected a source string.");
            }
            const svg = await this.#compile(input.source, disconnected.signal);
            res.writeHead(200, { ...privateHeaders, "content-type": "image/svg+xml", "content-length": svg.byteLength,
                "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
            res.end(svg);
        } catch (error) {
            if (!(disconnected.signal.aborted && error instanceof Error && (error.name === "AbortError"
                || ("code" in error && ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(String(error.code)))))) throw error;
        } finally {
            res.off("close", depart);
        }
    }

    async close() {
        this.#stop.abort();
        await this.#pool?.destroy();
    }
}
