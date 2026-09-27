// A one-page check of the plugin's own mark, for the browser rather than for jsdom:
// the mark is drawn by hand inside the panel and footer slots, which the preview pages
// cannot host, so this puts the glyph itself on a page.
//
// Usage: npx vitest run --config scripts/preview.vitest.config.ts
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it } from "vitest"
import { BrandGlyph } from "../src/client/components/icons"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

describe("brand glyph sheet", () => {
  it("writes the mark at the sizes the panel, footer and session button use", () => {
    const sizes = [16, 18, 20, 24, 32]
    const markup = renderToStaticMarkup(<div className="sheet">{sizes.map((size) => <span key={size}>{<BrandGlyph size={size} className="dws-brand-glyph" />}<em>{size}</em></span>)}</div>)
    writeFileSync(resolve("_preview/brand.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; padding: 20px; background: #fff; color: #0f1115; font: 12px system-ui; }
      .sheet { display: flex; align-items: flex-end; gap: 28px; }
      .sheet span { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .sheet em { color: #81858c; font-style: normal; }
    </style></head><body>${markup}</body></html>`)
    console.log("wrote _preview/brand.html")
  })
})
