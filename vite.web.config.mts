import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'web', plugins: [react()], build: { outDir: '../dist-web', emptyOutDir: true }, server: { host: '127.0.0.1', port: 5188, proxy: { '/api': 'http://127.0.0.1:4880' } } });
