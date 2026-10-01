// A browser page for a question jsdom cannot answer: how wide the plugin's select pill
// actually renders, so the one field a reader types into can be given the same width.
//
// Usage: npx vitest run --config scripts/preview.vitest.config.ts
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it } from "vitest"
import { writeFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Select } from "../src/client/components/ui"

describe("width ruler", () => {
  it("writes the select beside bands of known width", () => {
    const widths = [120, 140, 160, 180, 200]
    const markup = renderToStaticMarkup(<div className="ruler">
      {widths.map((width) => <div className="row" key={width}>
        <span className="tag">{width}px</span>
        <span className="band" style={{ width }} />
      </div>)}
      <div className="row">
        <span className="tag">select</span>
        <Select value="3" onChange={() => {}}><option value="3">3 层</option></Select>
      </div>
    </div>)
    const styles = readFileSync(resolve("src/client/styles.css"), "utf8")
    writeFileSync(resolve("_preview/ruler.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
      :root { --dsw-alias-label-primary: #0f1115; --dsw-alias-border-l2: rgb(0 0 0 / 10%);
        --dsw-alias-bg-module-platform: #f2f3f5; --dsw-alias-label-tertiary: #81858c;
        --dsw-alias-label-secondary: #61666b; --dsw-alias-bg-layer-1: #ffffff; --dsw-alias-bg-base: #f7f8fa;
        --dsw-alias-interactive-bg-hover: rgb(0 0 0 / 5%); --dws-radius-md: 12px; --wt-surface: #fff; --wt-line: #e5e5e5;
        --wt-text: #1f1f1f; --wt-muted: #81858c; --wt-secondary: #61666b; --wt-soft: #f2f3f5; }
      body { margin: 0; padding: 16px; background: #fff; font: 14px system-ui; color: #0f1115; }
      .row { display: flex; align-items: center; gap: 12px; margin: 6px 0; }
      .tag { width: 56px; color: #81858c; font-size: 12px; }
      .band { height: 36px; border: 1px dashed #dc2626; background: rgb(220 38 38 / 6%); }
      .dws-plugin-config { width: 520px; }
    </style><style>${styles}</style></head><body><div class="dws-plugin-config">${markup}</div></body></html>`)
    console.log("wrote _preview/ruler.html")
  })
})
