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
            // Stable library boundaries stay behind the preview's dynamic
            // imports; changing a viewer must not invalidate its whole engine.
            {
              name: 'three-core',
              test: /node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/,
              priority: 40,
              entriesAware: true,
            },
            {
              name: 'three-webgl',
              test: /node_modules[\\/]three[\\/]build[\\/]three\.module\.js$/,
              priority: 40,
              entriesAware: true,
            },
            {
              name: 'spreadsheet-codec',
              test: /node_modules[\\/]styled-exceljs[\\/]/,
              priority: 40,
              entriesAware: true,
            },
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
              entriesAware: true,
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](lucide-react|react-virtuoso)[\\/]/,
              priority: 20,
              entriesAware: true,
            },
            {
              name: 'chat-runtime',
              test: /[\\/]src[\\/](backend|hooks)[\\/]/,
              priority: 10,
              // A group is a naming/cache boundary, not permission to load
              // every member in every window. In particular, Vite's shared
              // preload helper must not pull chat state into Office previews.
              entriesAware: true,
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
