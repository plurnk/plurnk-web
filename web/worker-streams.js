import { $, $$, the } from "on_the_money";
import entryOutput from "./entry-output.js";

/** {§web-worker-streams} The census owns membership; events supply only observed progress and outcomes.
 * @param {HTMLElement} root
 * @param {(target: string) => Promise<import("@plurnk/plurnk-contracts").ClientEntry>} read
 */
export default function workerStreams(root, read) {
    const current = $(root, "[data-open-streams]");
    const outcomes = $(root, "[data-stream-outcomes] ol");
    if (!current || !outcomes) throw new Error("Worker streams have no outlets.");
    const inspect = entryOutput(root, read);
    // A progress event can precede the census introducing its stream. Counts never establish membership.
    /** @type {Map<number, Map<string, number>>} */
    const counts = new Map();
    /** @param {Element} row @param {number} entryId */
    const progress = (row, entryId) => {
        for (const channel of $$(row, "[data-stream-channel]")) {
            const name = the(channel, "stream-channel");
            the(channel, "stream-length", (name && counts.get(entryId)?.get(name)) ?? "Not observed");
        }
    };

    return {
        reset() {
            counts.clear();
            for (const row of $$(current, ":scope > li")) progress(row, Number(the(row, "stream-id")));
        },
        /** @param {readonly import("@plurnk/plurnk-contracts").ApplicationStream[]} streams */
        present(streams) {
            the(root, "stream-count", streams.length);
            const retained = new Set(streams.map(({ entryId }) => String(entryId)));
            for (const row of $$(current, ":scope > li")) if (!retained.has(the(row, "stream-id") ?? "")) row.remove();
            for (const [index, stream] of streams.entries()) {
                let row = $$(current, ":scope > li").find((item) => the(item, "stream-id") === String(stream.entryId));
                if (!row) {
                    row = $.clone(current, "#worker-stream");
                    const details = $(row, "details");
                    if (!details) throw new Error("Stream has no disclosure.");
                    inspect(details);
                }
                the(row, {
                    streamId: stream.entryId, streamTarget: stream.target, streamWorker: stream.workerId,
                    streamLifetime: stream.lifetime,
                });
                const channels = $(row, "[data-stream-channels]");
                if (!channels) throw new Error("Stream has no channel list.");
                const revision = JSON.stringify(stream.channels);
                if (the(channels, "stream-channels") !== revision) {
                    $.cloneEach(channels, "#worker-stream-channel", stream.channels, (channel, item) => {
                        the(channel, { streamChannel: item.channel, streamState: item.state, streamMime: item.mimetype });
                    });
                    the(channels, "stream-channels", revision);
                }
                progress(row, stream.entryId);
                if (current.children[index] !== row) current.insertBefore(row, current.children[index] ?? null);
            }
        },
        /** @param {import("@ag-ui/client").CustomEvent} event */
        async consume(event) {
            if (event.name !== "plurnk.stream") return;
            const value = event.value;
            if (!value || !Number.isSafeInteger(value.entryId) || value.entryId <= 0
                || !Number.isSafeInteger(value.workerId) || value.workerId <= 0 || typeof value.target !== "string" || !value.target) {
                throw new Error("Stream event has no resource identity.");
            }
            if ("result" in value) {
                const { Validator } = await import("@plurnk/plurnk-contracts");
                const result = Validator.assertOperationResult(value.result);
                if (typeof value.scheme !== "string" || typeof value.summary !== "string") throw new Error("Stream conclusion is incomplete.");
                counts.delete(value.entryId);
                const evidence = JSON.stringify(value);
                if ($$(outcomes, ":scope > li").some((row) => the(row, "stream-evidence") === evidence)) return;
                const row = $.clone(outcomes, "#worker-stream-outcome");
                the(row, {
                    streamEvidence: evidence, streamTarget: value.target, streamWorker: value.workerId,
                    streamScheme: value.scheme, streamSummary: value.summary, streamResult: JSON.stringify(result, null, 2),
                    streamProblem: result.problem?.detail ?? "", streamProblemTitle: result.problem?.title ?? "",
                });
                const details = $(row, "details");
                if (!details) throw new Error("Stream outcome has no disclosure.");
                inspect(details);
                return;
            }
            if (typeof value.channel !== "string" || !value.channel || !Number.isSafeInteger(value.contentLength) || value.contentLength < 0) {
                throw new Error("Stream progress is incomplete.");
            }
            let channels = counts.get(value.entryId);
            if (!channels) counts.set(value.entryId, channels = new Map());
            channels.set(value.channel, value.contentLength);
            const row = $$(current, ":scope > li").find((item) => the(item, "stream-id") === String(value.entryId));
            if (row) progress(row, value.entryId);
        },
    };
}
