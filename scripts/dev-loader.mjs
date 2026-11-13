import { registerHooks } from "node:module";

// {§web-build} Preload hook (`node --import /path/to/plurnk-web/scripts/dev-loader.mjs`)
// redirecting `@plurnk/plurnk-web` imports to this live source checkout.
const devModuleUrl = new URL("./dev-module.mjs", import.meta.url).href;
const manifestUrl = new URL("../package.json", import.meta.url).href;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@plurnk/plurnk-web/module") return { url: devModuleUrl, shortCircuit: true };
        if (specifier === "@plurnk/plurnk-web/package.json") return { url: manifestUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
