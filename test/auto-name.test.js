import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWorkspaceName, generateWorkerName } from "../ai.plurnk/auto-name.js";

test("{§web-workspace-creation} workspace candidate name is 5 alphanumeric characters with at least one letter", () => {
    const existing = new Set(["Abc01", "XyZ99"]);
    for (let i = 0; i < 50; i++) {
        const name = generateWorkspaceName(existing);
        assert.equal(name.length, 5);
        assert.match(name, /^[0-9A-Za-z]{5}$/u);
        assert.match(name, /[A-Za-z]/u, "contains at least one letter");
        assert.equal(existing.has(name), false, "avoids collisions");
    }
});

test("{§web-worker-creation} worker candidate name is 8 lowercase hex characters", () => {
    const existing = new Set(["01234567", "abcdef01"]);
    for (let i = 0; i < 50; i++) {
        const name = generateWorkerName(existing);
        assert.match(name, /^[0-9a-f]{8}$/u);
        assert.equal(existing.has(name), false, "avoids collisions");
    }
});