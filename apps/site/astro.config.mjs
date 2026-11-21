import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// The marketing site is static HTML (design direction, principle 4). React
// renders the shadcn components at build time; only the ones that need to
// move ship as islands (decision 0026).
export default defineConfig({
  output: "static",
  integrations: [react()],
  build: { inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    // Keep every image a cacheable file instead of an inline data URI.
    build: { assetsInlineLimit: 0 },
  },
});
