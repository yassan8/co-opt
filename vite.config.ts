import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  base: '/co-opt/',
  plugins: [
    react(),
    {
      name: 'inject-main-script',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          // Find the main.js bundle file name from the bundle
          if (ctx.bundle) {
            const mainChunk = Object.values(ctx.bundle).find(
              (chunk: any) => chunk.type === 'chunk' && chunk.name === 'main'
            );
            if (mainChunk && 'fileName' in mainChunk) {
              const scriptTag = `  <script type="module" crossorigin src="/co-opt/${mainChunk.fileName}"></script>\n`;
              return html.replace('</head>', scriptTag + '</head>');
            }
          }
          return html;
        }
      }
    }
  ],
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
      input: {
        app: "index.html",
        main: "main.js"
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Keep main.js with a stable name for script tags
          if (chunkInfo.name === 'main') {
            return 'assets/main-[hash].js';
          }
          return 'assets/[name]-[hash].js';
        }
      }
    }
  }
});
