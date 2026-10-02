import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Dev-only: serve `/config.json` (contract `PortalConfig`) from `web/dev-config.json`
 * so `main.tsx` follows the same runtime-config path as the deployed SPA.
 * In production the web stack writes `config.json` next to the built assets.
 */
function devConfigJson(): Plugin {
  const file = resolve(import.meta.dirname, 'dev-config.json');
  return {
    name: 'genome-portal-dev-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/config.json') return next();
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'NOT_FOUND',
              message: 'Create web/dev-config.json from web/dev-config.example.json',
            }),
          );
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const apiOrigin = env.VITE_API_ORIGIN;
  return {
    plugins: [
      react(),
      devConfigJson(),
      visualizer({
        filename: resolve(import.meta.dirname, 'build-stats', 'stats.html'),
        gzipSize: true,
        brotliSize: false,
        template: 'treemap',
      }),
    ],
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@aws-amplify/ui-react-storage')) return 'storage';
            if (id.includes('aws-amplify') || id.includes('@aws-amplify')) return 'amplify';
            if (id.includes('hash-wasm') || id.includes('client-zip') || id.includes('/idb/'))
              return 'download';
            return undefined;
          },
        },
      },
    },
    worker: { format: 'es' },
    server: {
      port: 5173,
      proxy: apiOrigin
        ? {
            '/api': { target: apiOrigin, changeOrigin: true, secure: true },
          }
        : undefined,
    },
  };
});
