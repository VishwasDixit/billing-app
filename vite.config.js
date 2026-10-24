import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false, // registered in src/main.jsx so updates also reload open pages
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Billing – Shop POS",
        short_name: "Billing",
        description: "Billing, thermal printing and sales analytics for shops",
        theme_color: "#0f766e",
        background_color: "#f5f6f8",
        display: "standalone",
        id: "/",
        start_url: "/",
        scope: "/",
        orientation: "any",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          // Full-bleed with padding, so Android launchers can crop it to any shape.
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "New bill", url: "/", icons: [{ src: "icon-192.png", sizes: "192x192" }] },
          { name: "Orders", url: "/orders", icons: [{ src: "icon-192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // A new version takes over open pages straight away (src/main.jsx then reloads them).
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api/],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Uploaded menu photos never change (a new photo gets a new URL), so cache them for offline billing.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/menu-images/"),
            handler: "CacheFirst",
            options: {
              cacheName: "menu-photos",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Menu photos picked from the photo libraries (links never change).
          {
            urlPattern: ({ url }) => ["https://images.pexels.com", "https://upload.wikimedia.org", "https://thumb.wikimedia.org"].includes(url.origin),
            handler: "CacheFirst",
            options: {
              cacheName: "library-photos",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" },
  },
  test: {
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
