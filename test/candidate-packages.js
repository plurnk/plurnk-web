import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

// {§web-package} Until the authority API is published, test its real packed candidate, not a mock.
export default async function candidatePackages() {
    const input = process.env.PLURNK_WEB_TEST_PACKAGES;
    if (!input) throw new Error("Set PLURNK_WEB_TEST_PACKAGES to the directory of packed daemon candidate archives (including contracts, modules, AG-UI and service).");
    const directory = resolve(input);
    const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz")).map((name) => join(directory, name));
    for (const name of ["service", "contracts", "agui", "modules"]) {
        if (!archives.some((path) => path.includes(`/plurnk-plurnk-${name}-`))) throw new Error(`Candidate archives omit @plurnk/plurnk-${name}`);
    }
    return archives;
}
