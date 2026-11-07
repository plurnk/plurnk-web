import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import candidatePackages from "../test/candidate-packages.js";

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error("Usage: npm run test:candidate -- <packed-platform-directory>");
process.env.PLURNK_WEB_TEST_PACKAGES = resolve(directory);
const archives = await candidatePackages();
const checkout = fileURLToPath(new URL("../", import.meta.url));
/** @param {string[]} args @param {string} cwd */
const npm = (args, cwd) => new Promise((accept, reject) => {
    const child = spawn("npm", args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? accept(undefined) : reject(new Error(`npm exited ${code ?? signal}`)));
});

// The gate proves the committed HEAD in a throwaway clone that shares the checkout's objects: the checkout, which may be the one
// a daemon serves, is only read.
const clone = await mkdtemp(join(tmpdir(), "plurnk-web-gate-"));
/** @param {string[]} args @param {string} cwd @returns {Promise<string>} */
const git = (args, cwd) => new Promise((accept, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : accept(stdout.trim()));
});
const head = await git(["rev-parse", "HEAD"], checkout);
console.log(`Gating ${head} in ${clone}`);
await git(["clone", "--quiet", "--shared", "--no-checkout", checkout, clone], checkout);
await git(["checkout", "--quiet", "--detach", head], clone);
try {
    await npm(["ci", "--no-audit", "--no-fund"], clone);
    // Candidate public declarations and authorization specimens beside the locked registry graph.
    const peerArchives = archives.filter((path) => /\/plurnk-plurnk-(?:acp|auth|contracts|meta|modules|parser|spec-check)-/u.test(path));
    await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", ...peerArchives], clone);
    await npm(["test"], clone);
    await npm(["run", "test:installation"], clone);
} catch (error) {
    console.error(`The gate failed; its clone remains at ${clone}`);
    throw error;
}
await rm(clone, { recursive: true, force: true });
