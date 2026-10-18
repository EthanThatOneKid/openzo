import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(), 
  ],
  server: {
    allowedHosts: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false, ws: true },
      "/eve": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  base: "/",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  esbuild: {
    loader: 'tsx',
    include: /\.(tsx?|jsx?|zopage)$/,
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.zopage': 'tsx',
      },
    },
  },
});
