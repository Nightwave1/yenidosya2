import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/** Bundle schemas straight from workspace source — no dist dependency. */
const schemasSource = fileURLToPath(new URL('../../packages/schemas/src/index.ts', import.meta.url))

/**
 * Web-booking PWA (`/berber-ahmet`).
 *
 * Dev: proxies /v1 (REST) and /ws (Socket.IO) to the NestJS API on :4000.
 * Prod: same-origin gateway, or set VITE_API_URL when the API lives elsewhere.
 *
 * The service worker precaches the app shell and caches only
 * profile/services/staff reads (NetworkFirst). Availability is intentionally
 * never served from cache — a stale slot grid must not invite a failed booking.
 */
export default defineConfig({
  resolve: {
    alias: { '@oleum/schemas': schemasSource },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-mask.svg'],
      manifest: {
        id: '/',
        name: 'Randevu',
        short_name: 'Randevu',
        description: 'Berber dükkanları için hızlı randevu uygulaması',
        lang: 'tr',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        categories: ['lifestyle', 'shopping'],
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-mask.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^\/v1\/public\/tenants\/[^/]+(\/(services|staff))?$/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'public-catalog',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 40, maxAgeSeconds: 600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
})
