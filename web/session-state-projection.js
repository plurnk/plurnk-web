import { isRecord } from "./session-translator.js";

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} rawResult
 * @param {Record<string, unknown> | undefined} metaPlurnk
 * @param {(descendants: readonly unknown[]) => void} onDescendants
 * @returns {{ appliedMeta: boolean, state: Record<string, unknown> }}
 */
export function applyResponseState(state, rawResult, metaPlurnk, onDescendants) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    if (Array.isArray(rawResult.configOptions)) {
        prevPlurnk.configOptions = structuredClone(rawResult.configOptions);
    }
    if (Array.isArray(rawResult.availableCommands)) {
        prevPlurnk.availableCommands = structuredClone(rawResult.availableCommands);
    }
    if (metaPlurnk) {
        const {
            stopReason: _stopReason,
            terminal: _terminal,
            result: _result,
            history: _history,
            action: _action,
            proposal: _proposal,
            interaction: _interaction,
            budget,
            status,
            workspace,
            ...rest
        } = metaPlurnk;
        Object.assign(prevPlurnk, structuredClone(rest));
        if (isRecord(status)) {
            if (Array.isArray(status.descendants)) {
                onDescendants(status.descendants);
            }
            prevPlurnk.status = {
                ...(isRecord(prevPlurnk.status) ? prevPlurnk.status : {}),
                ...structuredClone(status),
            };
        }
        if (isRecord(workspace)) {
            prevPlurnk.workspace = {
                ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                ...structuredClone(workspace),
            };
        }
        return {
            appliedMeta: true,
            state: {
                ...state,
                plurnk: prevPlurnk,
                ...(budget !== undefined ? { budget: structuredClone(budget) } : {}),
            },
        };
    }
    if (Array.isArray(rawResult.configOptions) || Array.isArray(rawResult.availableCommands)) {
        return {
            appliedMeta: false,
            state: {
                ...state,
                plurnk: prevPlurnk,
            },
        };
    }
    return { appliedMeta: false, state };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {Record<string, unknown>}
 */
export function applyConfigOptionUpdate(state, update, plurnk) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    if (Array.isArray(update.configOptions)) {
        prevPlurnk.configOptions = structuredClone(update.configOptions);
    }
    if (plurnk) {
        const { budget, status, workspace, ...rest } = structuredClone(plurnk);
        Object.assign(prevPlurnk, rest);
        if (isRecord(status)) {
            prevPlurnk.status = {
                ...(isRecord(prevPlurnk.status) ? prevPlurnk.status : {}),
                ...status,
            };
        }
        if (isRecord(workspace)) {
            prevPlurnk.workspace = {
                ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                ...workspace,
            };
        }
        return {
            ...state,
            plurnk: prevPlurnk,
            ...(budget !== undefined ? { budget } : {}),
        };
    }
    return {
        ...state,
        plurnk: prevPlurnk,
    };
}

/** @param {unknown} rawBlocks @returns {string} */
function extractSuggestionText(rawBlocks) {
    if (!Array.isArray(rawBlocks)) return "";
    return rawBlocks.map((block) => {
        if (!isRecord(block)) return "";
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "skill" && typeof block.name === "string") return `$${block.name}`;
        return "";
    }).join("").trim();
}

/**
 * @param {Record<string, unknown>} state
 * @param {readonly unknown[]} availableCommands
 * @returns {Record<string, unknown>}
 */
export function applyAvailableCommandsUpdate(state, availableCommands) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    prevPlurnk.availableCommands = structuredClone(availableCommands);
    return {
        ...state,
        plurnk: prevPlurnk,
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {readonly unknown[]} suggestions
 * @returns {Record<string, unknown>}
 */
export function applyPromptSuggestionsUpdate(state, suggestions) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    prevPlurnk.promptSuggestions = suggestions
        .map((entry) => isRecord(entry) ? extractSuggestionText(entry.prompt) : "")
        .filter((text) => text.length > 0);
    return {
        ...state,
        plurnk: prevPlurnk,
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {Record<string, unknown>}
 */
export function applyUsageUpdate(state, update, plurnk) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
    if (plurnk) {
        if (isRecord(plurnk.status)) {
            Object.assign(prevStatus, structuredClone(plurnk.status));
        }
        if (isRecord(plurnk.workspace)) {
            prevPlurnk.workspace = {
                ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                ...structuredClone(plurnk.workspace),
            };
        }
        if (Array.isArray(plurnk.providers)) {
            prevPlurnk.providers = structuredClone(plurnk.providers);
        }
    }
    if (Object.keys(prevStatus).length > 0) {
        prevPlurnk.status = prevStatus;
    }
    const budget = isRecord(plurnk?.budget)
        ? structuredClone(plurnk.budget)
        : typeof update.used === "number" && typeof update.size === "number"
            ? {
                ...(isRecord(state.budget) ? state.budget : {}),
                contextTokens: update.used,
                contextCapacity: update.size,
            }
            : undefined;
    return {
        ...state,
        plurnk: prevPlurnk,
        ...(budget !== undefined ? { budget } : {}),
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {number} childId
 * @param {string} childName
 * @param {string} rawLifecycle
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {Record<string, unknown>}
 */
export function applySubagentState(state, childId, childName, rawLifecycle, plurnk) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
    const descendants = Array.isArray(prevStatus.descendants)
        ? prevStatus.descendants.map((d) => structuredClone(d))
        : [];
    const idx = descendants.findIndex((d) => isRecord(d) && (d.id === childId || d.name === childName));
    const nextEntry = {
        ...(idx !== -1 && isRecord(descendants[idx]) ? descendants[idx] : {}),
        id: childId,
        name: childName,
        parentSessionId: typeof plurnk?.parentSessionId === "number" ? plurnk.parentSessionId : null,
        kind: typeof plurnk?.kind === "string" ? plurnk.kind : "session",
        lifecycle: rawLifecycle,
        gates: Array.isArray(plurnk?.gates)
            ? structuredClone(plurnk.gates)
            : (idx !== -1 && isRecord(descendants[idx]) && Array.isArray(descendants[idx].gates)
                ? descendants[idx].gates
                : []),
    };
    if (idx === -1) descendants.push(nextEntry);
    else descendants[idx] = nextEntry;
    prevStatus.descendants = descendants;
    prevPlurnk.status = prevStatus;
    return {
        ...state,
        plurnk: prevPlurnk,
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {{ changed: boolean, state: Record<string, unknown> }}
 */
export function applyLifecycleStateUpdate(state, update, plurnk) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
    let suggestionsCleared = false;
    if (update.state === "running" && Array.isArray(prevPlurnk.promptSuggestions) && prevPlurnk.promptSuggestions.length > 0) {
        prevPlurnk.promptSuggestions = [];
        suggestionsCleared = true;
    }
    if (isRecord(plurnk?.status)) {
        Object.assign(prevStatus, structuredClone(plurnk.status));
    }
    const stateNotice = isRecord(plurnk?.notice) ? plurnk.notice : undefined;
    if (stateNotice?.source === "engine:lifecycle" && stateNotice.kind === "loop_status") {
        const code = typeof stateNotice.status === "number" ? stateNotice.status : 102;
        prevStatus.lifecycle = code === 100 ? "queued" : code === 202 ? "parked" : "running";
        if (typeof stateNotice.loopSeq === "number") prevStatus.loopSeq = stateNotice.loopSeq;
        if (typeof stateNotice.packetCount === "number") prevStatus.packetCount = stateNotice.packetCount;
        if (stateNotice.waitUntil === null || typeof stateNotice.waitUntil === "number") {
            prevStatus.waitUntil = stateNotice.waitUntil;
        }
        if (stateNotice.claimedAt === null || typeof stateNotice.claimedAt === "number") {
            prevStatus.claimedAt = stateNotice.claimedAt;
        }
    } else if (update.state === "running" && prevStatus.lifecycle !== "queued" && prevStatus.lifecycle !== "parked") {
        prevStatus.lifecycle = "running";
        prevStatus.waitUntil = null;
        prevPlurnk.laneQueue = null;
    } else if (update.state === "idle" && isRecord(plurnk?.terminal)) {
        const termStatus = typeof plurnk.terminal.status === "number" ? plurnk.terminal.status : 200;
        prevStatus.lifecycle = termStatus === 499 ? "cancelled" : termStatus >= 400 ? "failed" : "completed";
        prevStatus.waitUntil = null;
        prevPlurnk.laneQueue = null;
        prevPlurnk.turnPhase = null;
    }
    if (Object.keys(prevStatus).length === 0 && !suggestionsCleared) {
        return { changed: false, state };
    }
    if (Object.keys(prevStatus).length > 0) {
        prevPlurnk.status = prevStatus;
    }
    return {
        changed: true,
        state: {
            ...state,
            plurnk: prevPlurnk,
        },
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {{ changed: boolean, state: Record<string, unknown> }}
 */
export function applyNoticeStateUpdate(state, plurnk) {
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
    const notice = isRecord(plurnk?.notice) ? plurnk.notice : undefined;
    let stateChanged = false;

    if (notice?.source === "engine:turn" && notice.kind === "turn_queued") {
        prevStatus.lifecycle = "queued";
        prevStatus.terminatedAt = null;
        prevPlurnk.status = prevStatus;
        prevPlurnk.laneQueue = {
            position: typeof notice.queuePosition === "number" ? notice.queuePosition : null,
            depth: typeof notice.queueDepth === "number" ? notice.queueDepth : null,
            laneLimit: typeof notice.laneLimit === "number" ? notice.laneLimit : null,
        };
        prevPlurnk.turnPhase = null;
        stateChanged = true;
    }
    if (notice?.source === "engine:turn" && (notice.kind === "turn_awaiting_model" || notice.kind === "turn_generated")) {
        if (prevPlurnk.laneQueue !== null && prevPlurnk.laneQueue !== undefined) {
            prevPlurnk.laneQueue = null;
            stateChanged = true;
        }
        const nextPhase = notice.kind === "turn_awaiting_model" ? "awaiting-model" : null;
        if ((prevPlurnk.turnPhase ?? null) !== nextPhase) {
            prevPlurnk.turnPhase = nextPhase;
            stateChanged = true;
        }
        if (prevStatus.lifecycle === "queued") {
            prevStatus.lifecycle = "running";
            prevPlurnk.status = prevStatus;
            stateChanged = true;
        }
    }
    if (notice?.source === "engine:lifecycle" && notice.kind === "loop_status") {
        const code = typeof notice.status === "number" ? notice.status : 102;
        prevStatus.lifecycle = code === 100 ? "queued" : code === 202 ? "parked" : "running";
        if (code !== 100) prevPlurnk.laneQueue = null;
        if (code !== 102) prevPlurnk.turnPhase = null;
        if (typeof notice.loopSeq === "number") prevStatus.loopSeq = notice.loopSeq;
        if (typeof notice.packetCount === "number") prevStatus.packetCount = notice.packetCount;
        if (notice.waitUntil === null || typeof notice.waitUntil === "number") {
            prevStatus.waitUntil = notice.waitUntil;
        }
        if (notice.claimedAt === null || typeof notice.claimedAt === "number") {
            prevStatus.claimedAt = notice.claimedAt;
        }
        prevStatus.terminatedAt = null;
        prevPlurnk.status = prevStatus;
        stateChanged = true;
    }
    if (notice?.source === "engine:derivation" && notice.kind === "search_progress") {
        const ws = isRecord(prevPlurnk.workspace) ? { ...prevPlurnk.workspace } : {};
        ws.activity = notice.phase === "complete"
            ? null
            : {
                kind: "derivation",
                phase: notice.phase,
                ...(typeof notice.completed === "number" ? { completed: notice.completed } : {}),
                ...(typeof notice.total === "number" ? { total: notice.total } : {}),
                ...(typeof notice.percent === "number" ? { percent: notice.percent } : {}),
                ...(typeof notice.message === "string" ? { message: notice.message } : {}),
            };
        prevPlurnk.workspace = ws;
        stateChanged = true;
    }
    if (isRecord(plurnk?.status)) {
        Object.assign(prevStatus, structuredClone(plurnk.status));
        prevPlurnk.status = prevStatus;
        stateChanged = true;
    }
    if (isRecord(plurnk?.workspace)) {
        prevPlurnk.workspace = {
            ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
            ...structuredClone(plurnk.workspace),
        };
        stateChanged = true;
    }
    if (Array.isArray(plurnk?.preparation) && isRecord(prevPlurnk.workspace)) {
        prevPlurnk.workspace = {
            ...prevPlurnk.workspace,
            preparation: structuredClone(plurnk.preparation),
        };
        stateChanged = true;
    }
    if (!stateChanged) {
        return { changed: false, state };
    }
    return {
        changed: true,
        state: {
            ...state,
            plurnk: prevPlurnk,
        },
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown> | undefined} plurnk
 * @returns {{ changed: boolean, state: Record<string, unknown> }}
 */
export function applyTerminalStreamUpdate(state, update, plurnk) {
    const entryId = typeof plurnk?.entryId === "number" ? plurnk.entryId : undefined;
    const target = typeof plurnk?.target === "string" ? plurnk.target : undefined;
    if (entryId === undefined || target === undefined) {
        return { changed: false, state };
    }
    const prevPlurnk = isRecord(state.plurnk) ? { ...state.plurnk } : {};
    const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
    const streams = Array.isArray(prevStatus.streams)
        ? prevStatus.streams.map((s) => structuredClone(s))
        : [];
    if (isRecord(update.exitStatus)) {
        prevStatus.streams = streams.filter((s) => !(isRecord(s) && s.entryId === entryId));
    } else {
        const idx = streams.findIndex((s) => isRecord(s) && s.entryId === entryId);
        const chName = typeof plurnk?.channel === "string" ? plurnk.channel : "stdout";
        const chState = typeof plurnk?.state === "string" ? plurnk.state : "open";
        const chMime = typeof plurnk?.mimetype === "string" ? plurnk.mimetype : "text/plain";
        if (idx === -1) {
            streams.push({
                entryId,
                sessionId: typeof plurnk?.sessionId === "number" ? plurnk.sessionId : 1,
                target,
                ...(typeof plurnk?.loopSeq === "number" ? { loopSeq: plurnk.loopSeq } : {}),
                ...(typeof plurnk?.turnSeq === "number" ? { turnSeq: plurnk.turnSeq } : {}),
                ...(typeof plurnk?.sequence === "number" ? { sequence: plurnk.sequence } : {}),
                channels: [{ channel: chName, state: chState, mimetype: chMime }],
            });
        } else if (isRecord(streams[idx])) {
            const existingChannels = Array.isArray(streams[idx].channels) ? [...streams[idx].channels] : [];
            const cIdx = existingChannels.findIndex((c) => isRecord(c) && c.channel === chName);
            const chEntry = { channel: chName, state: chState, mimetype: chMime };
            if (cIdx === -1) existingChannels.push(chEntry);
            else existingChannels[cIdx] = chEntry;
            streams[idx] = { ...streams[idx], channels: existingChannels };
        }
        prevStatus.streams = streams;
    }
    prevPlurnk.status = prevStatus;
    return {
        changed: true,
        state: {
            ...state,
            plurnk: prevPlurnk,
        },
    };
}
