import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Billing – Shop POS",
        short_name: "Billing",
        description: "Billing, thermal printing and sales analytics for shops",
        theme_color: "#0f766e",
        background_color: "#f5f6f8",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
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
          // Menu photos picked from the Pexels library (links never change).
          {
            urlPattern: ({ url }) => url.origin === "https://images.pexels.com",
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
