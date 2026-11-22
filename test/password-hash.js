import { randomBytes, scryptSync } from "node:crypto";

/**
 * Derive a test-tier `PLURNK_AUTH_PASSWORD_HASH` value (`scrypt:1024:8:1:<salt>:<digest>`).
 * @param {string} password
 * @returns {string}
 */
export default function testPasswordHash(password) {
    const salt = randomBytes(16);
    const digest = scryptSync(Buffer.from(password, "utf8"), salt, 32, { N: 1024, r: 8, p: 1 });
    return `scrypt:1024:8:1:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}
