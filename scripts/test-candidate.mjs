import { spawn } from "node:child_process";
import { resolve } from "node:path";
import candidatePackages from "../test/candidate-packages.js";

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error("Usage: npm run test:candidate -- <packed-platform-directory>");
process.env.PLURNK_WEB_TEST_PACKAGES = resolve(directory);
const archives = await candidatePackages();
const root = new URL("../", import.meta.url);
const run = (args) => new Promise((accept, reject) => {
    const child = spawn("npm", args, { cwd: root, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`npm exited ${code ?? signal}`)));
});

// Candidate public declarations and authorization specimens; the lockfile remains a registry graph.
await run(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
    ...archives,
]);
await run(["test"]);
