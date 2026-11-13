import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// {§web-package} Exercise installed platform archives, not a source checkout or a mock.
export default async function candidatePackages() {
    const input = process.env.PLURNK_WEB_TEST_PACKAGES;
    if (!input) throw new Error("Set PLURNK_WEB_TEST_PACKAGES to the directory of packed platform and terminal client archives.");
    const directory = resolve(input);
    const archives = (await readdir(directory)).filter((name) => name.startsWith("plurnk-") && name.endsWith(".tgz")).map((name) => join(directory, name));
    for (const name of ["service", "contracts", "acp", "auth", "modules"]) {
        if (!archives.some((path) => path.includes(`/plurnk-plurnk-${name}-`))) throw new Error(`Candidate archives omit @plurnk/plurnk-${name}`);
    }
    if (!archives.some((path) => /\/plurnk-plurnk-\d[^/]*\.tgz$/u.test(path))) throw new Error("Candidate archives omit @plurnk/plurnk (the terminal client).");
    return archives;
}
