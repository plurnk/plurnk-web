/** {§web-worker-observer} Elapsed time is a projection of daemon timestamps, not a browser stopwatch.
 * @param {import("@plurnk/plurnk-agui/client").AguiStatusState} status @param {number} now
 */
export function elapsed(status, now) {
    if (status.claimedAt === null) return "Unknown";
    const seconds = Math.max(0, Math.floor(((status.terminatedAt ?? now) - status.claimedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${hours ? `${hours}h ` : ""}${hours || minutes ? `${minutes}m ` : ""}${seconds % 60}s`;
}

/** @param {import("@plurnk/plurnk-agui/client").AguiStatusState} status */
export function gauges(status) {
    return {
        lifecycle: status.lifecycle,
        loop: status.loopId === null ? "None" : String(status.loopId),
        turns: String(status.packetCount),
        requests: String(status.spend.requests),
        input: String(status.spend.usage?.inputTokens ?? "Unknown"),
        output: String(status.spend.usage?.outputTokens ?? "Unknown"),
        cost: status.spend.costUsd ?? "Unknown",
    };
}
