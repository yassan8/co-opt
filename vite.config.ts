import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: '/co-opt/',
  plugins: [react()],
  resolve: {
    alias: {
      OrbitControls: "three/examples/jsm/controls/OrbitControls.js",
      three: "three"
    }
  },
  optimizeDeps: {
    entries: ["index.html"],
    include: ["three", "three/examples/jsm/controls/OrbitControls.js"]
  },
  build: {
    rollupOptions: {
      input: "index.html"
    }
  }
});
