import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  base: '/co-opt/',
  server: {
    watch: {
      ignored: ['**/src-tauri/target/**']
    }
  },
  worker: {
    format: 'es'
  },
  plugins: [
    react(),
    {
      name: 'coopt-wasm-thread-headers',
      configureServer(server) {
        server.middlewares.use((_request, response, next) => {
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((_request, response, next) => {
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          next();
        });
      }
    },
    {
      name: 'inject-main-script',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          // In production: Remove the dev mode main.ts script tag and add bundled version
          // In development: Keep the /main.ts script tag as-is
          if (ctx.bundle) {
            // Production mode: replace with bundled version
            html = html.replace(/<script type="module" src="\/main\.ts"><\/script>\s*/g, '');
            
            // Find the main.js bundle file name from the bundle
            const mainChunk = Object.values(ctx.bundle).find(
              (chunk: any) => chunk.type === 'chunk' && chunk.name === 'main'
            );
            if (mainChunk && 'fileName' in mainChunk) {
              const scriptTag = `<script type="module" crossorigin src="/co-opt/${mainChunk.fileName}"></script>\n`;
              // Insert main.js script as the first script tag (before app.js)
              // Find the first <script type="module" and insert before it
              const firstScriptMatch = html.match(/(<script type="module" crossorigin src="[^"]+app-[^"]+\.js"><\/script>)/);
              if (firstScriptMatch) {
                return html.replace(firstScriptMatch[1], scriptTag + '  ' + firstScriptMatch[1]);
              }
              // Fallback: insert before </head>
              return html.replace('</head>', '  ' + scriptTag + '</head>');
            }
          }
          // Development mode: keep the /main.ts script tag as-is
          return html;
        }
      }
    }
  ],
  resolve: {
    dedupe: ["three"],
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
        main: "main.ts",
      },
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
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
