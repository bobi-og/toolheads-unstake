import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  base: "./",
  plugins: [wasm()],
  resolve: { alias: { buffer: "buffer/", events: "events/" } },
  build: { target: "es2022", chunkSizeWarningLimit: 20000 },
  optimizeDeps: { exclude: ["@lucid-evolution/lucid", "@lucid-evolution/uplc"] },
  // `npm run dev`: same /koios path as production (Cloudflare Function) and serve.py
  server: {
    proxy: {
      "/koios": {
        target: "https://api.koios.rest", changeOrigin: true,
        rewrite: (p) => p.replace(/^\/koios/, "/api/v1"),
      },
    },
  },
});
