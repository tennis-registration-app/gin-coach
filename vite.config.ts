import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works at any GitHub Pages path.
export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: mode === 'artifact' ? 'dist-artifact' : 'dist' },
  plugins: [
    react(),
    // the hosted preview build (mode "artifact") cannot use a service worker
    mode !== 'artifact' && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Gin Coach',
        short_name: 'Gin Coach',
        description: 'Practice partnership Oklahoma gin against bots with move-by-move coaching.',
        theme_color: '#173a2e',
        background_color: '#173a2e',
        display: 'standalone',
        start_url: '.',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,json}'], maximumFileSizeToCacheInBytes: 4_000_000 },
    }),
  ],
}));
