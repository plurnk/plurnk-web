import { randomBytes, randomInt } from "node:crypto";

const WORKSPACE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * {§web-workspace-creation} A candidate workspace name with five
 * alphanumeric characters, at least one a letter.
 * @param {Set<string> | ReadonlySet<string>} [existing]
 * @returns {string}
 */
export function generateWorkspaceName(existing = new Set()) {
    let name;
    do {
        name = Array.from({ length: 5 }, () => WORKSPACE_ALPHABET[randomInt(WORKSPACE_ALPHABET.length)]).join("");
    } while (!/[A-Za-z]/u.test(name) || existing.has(name));
    return name;
}

/**
 * {§web-worker-creation} Candidate worker names are eight random lowercase hexadecimal characters.
 * @param {Set<string> | ReadonlySet<string>} [existing]
 * @returns {string}
 */
export function generateWorkerName(existing = new Set()) {
    let name;
    do {
        name = randomBytes(4).toString("hex");
    } while (existing.has(name));
    return name;
}