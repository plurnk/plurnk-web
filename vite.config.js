import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
    root: fileURLToPath(new URL("./web/", import.meta.url)),
    appType: "mpa",
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    build: {
        outDir: fileURLToPath(new URL("./ai.plurnk/dist/", import.meta.url)),
        emptyOutDir: true,
    },
});
