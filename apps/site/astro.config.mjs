import { defineConfig } from "astro/config";

// The marketing site is static HTML (design direction, principle 4).
export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  // Keep every image a cacheable file instead of an inline data URI.
  vite: { build: { assetsInlineLimit: 0 } },
});
