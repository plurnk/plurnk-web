import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/browser"),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/browser"),
    emptyOutDir: false,
    sourcemap: false,
  },
});
