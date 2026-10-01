/**
 * Renders the plugin's surfaces to `_preview/*.html`, which a browser can open without
 * the GUI. Its own config keeps the development tool out of the project's test run and
 * `_preview/` out of the package, and it is not referenced by any published entry.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["scripts/preview.render.tsx", "scripts/brand.check.tsx", "scripts/ruler.check.tsx"],
  },
})
