import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createWatchState,
    isActiveLoopLifecycle,
    reduceWatchNotification,
    watchSessionKey,
} from "../web/watch-store.js";

test("{§web-search} {§web-session-directory} watch-store classifies active lifecycles, materializes woken omitted sessions from loop/started.session, and flags resync on unknown omitted deltas", () => {
    assert.equal(isActiveLoopLifecycle("running"), true);
    assert.equal(isActiveLoopLifecycle("parked"), true);
    assert.equal(isActiveLoopLifecycle("queued"), true);
    assert.equal(isActiveLoopLifecycle("idle"), false);
    assert.equal(isActiveLoopLifecycle("completed"), false);
    assert.equal(isActiveLoopLifecycle("cancelled"), false);
    assert.equal(isActiveLoopLifecycle("failed"), false);

    let state = createWatchState();
    const snapshot = reduceWatchNotification(state, {
        id: 5,
        event: "notifications/snapshot",
        timestamp: 1000,
        workspaceId: 1,
        sessionId: null,
        data: {
            reason: "initial",
            epoch: "e1",
            latestId: 5,
            workspaces: [{ id: 1, name: "alpha", projectRoot: null, projectLabel: null }],
            sessions: [
                {
                    workspaceId: 1,
                    id: 2,
                    name: "recent",
                    parentSessionId: null,
                    parentName: null,
                    parentOrigin: null,
                    kind: "root",
                    lifecycle: "completed",
                    gates: 0,
                    reply: { id: 20, coordinate: "1/1/1", completion: 200, at: 2000, excerpt: "done", continued: false },
                },
            ],
            proposals: [],
            interactions: [],
            omitted: 1,
        },
    });
    assert.equal(snapshot.resyncRequired, false);
    state = snapshot.state;
    assert.equal(state.omitted, 1);

    const woke = reduceWatchNotification(state, {
        id: 6,
        event: "loop/started",
        timestamp: 1100,
        workspaceId: 1,
        sessionId: 1,
        data: {
            sessionId: 1,
            loopId: 3,
            loopSeq: 2,
            opening: "Follow-up",
            session: {
                workspaceId: 1,
                id: 1,
                name: "older",
                parentSessionId: null,
                parentName: null,
                parentOrigin: null,
                kind: "root",
                lifecycle: "running",
                gates: 0,
                opening: "Initial prompt",
                title: "Older Thread",
                reply: { id: 10, coordinate: "1/1/1", completion: 200, at: 1000, excerpt: "prev", continued: false },
            },
        },
    });
    assert.equal(woke.resyncRequired, false);
    assert.equal(woke.changed, true);
    state = woke.state;
    assert.equal(state.omitted, 0);
    const materialized = state.sessions.get(watchSessionKey(1, 1));
    assert.equal(materialized?.name, "older");
    assert.equal(materialized?.lifecycle, "running");
    assert.equal(materialized?.opening, "Initial prompt");
    assert.equal(materialized?.title, "Older Thread");

    const unarchive = reduceWatchNotification(state, {
        id: 7,
        event: "session/archived",
        timestamp: 1200,
        workspaceId: 1,
        sessionId: 9,
        data: { id: 9, archivedAt: null, sessionIds: [9] },
    });
    assert.equal(unarchive.resyncRequired, true);
});
