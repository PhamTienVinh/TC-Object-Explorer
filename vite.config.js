import { defineConfig } from "vite";

export default defineConfig({
  base: "/TC-Object-Explorer/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
  server: {
    port: 3000,
  },
});
