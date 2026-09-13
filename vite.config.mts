import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Open windows may still import chunks from the previous build. Keep their
    // content-addressed assets until those windows have gone away; replacing
    // index.html must not invalidate a running conversation's lazy imports.
    emptyOutDir: false,
    rolldownOptions: {
      input: {
        main: path.resolve(rootDir, 'index.html'),
        officePreview: path.resolve(rootDir, 'office-preview.html'),
        modelPreview: path.resolve(rootDir, 'model-preview.html'),
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](lucide-react|react-virtuoso)[\\/]/,
              priority: 20,
            },
            {
              name: 'chat-runtime',
              test: /[\\/]src[\\/](backend|hooks)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
