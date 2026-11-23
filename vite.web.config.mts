import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { languageChunkGroups } from './scripts/vite-language-chunks.mjs';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            ...languageChunkGroups(),
            { name: 'react-vendor', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, entriesAware: true },
            { name: 'conversation-virtualization', test: /node_modules[\\/]react-virtuoso[\\/]/, entriesAware: true },
            { name: 'protocol-validation', test: /node_modules[\\/]zod[\\/]/, entriesAware: true },
            {
              name: 'conversation-rendering',
              test: /[\\/]src[\\/]features[\\/](?:chatMessages|tools)[\\/]/,
              entriesAware: true,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5188, proxy: { '/api': 'http://127.0.0.1:4880' } },
});
