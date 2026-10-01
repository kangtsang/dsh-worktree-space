// Build a probe page from the real config markup and stylesheet, to see whether the
// rendered stylesheet draws the prefix input's border.
//
// Usage: node scripts/preview.probe.mjs [page]   (default config)
// Writes _preview/probe2.html from the rendered page's own tokens, styles and prefix row,
// which is how a stylesheet question gets answered without the GUI.
import { readFileSync, writeFileSync } from "node:fs"

const page = process.argv[2] ?? "config"
const html = readFileSync(`_preview/${page}.html`, "utf8")
const style = html.match(/<style>[\s\S]*?<\/style>/)[0]
const root = html.match(/:root\s*\{[\s\S]*?\}/)[0]
const row = html.match(/<div class="dws-plugin-config-row dws-plugin-config-prefix">[\s\S]*?<\/div><\/div>/)[0]
writeFileSync("_preview/probe2.html", `<!doctype html><html><head><meta charset="utf-8"><style>${root}</style>${style}</head><body><div class="dws-plugin-config" style="padding:20px">${row}</div></body></html>`)
console.log("wrote _preview/probe2.html; row length", row.length)
