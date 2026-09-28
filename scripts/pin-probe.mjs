// Prove where the panel's scrollbar lives, and that its two columns start on one line:
// render the real panel page in a viewport-height box, scroll the row list to its end, and
// report what scrolled, what stayed, and where the first view tab begins relative to the
// toolbar it switches. A pinned header reads as "the list scrolled to its end and the
// heading never moved"; the alignment reads as "tabTop - toolbarTop = 0".
//
// Usage: node scripts/pin-probe.mjs   (needs a fresh _preview/panel.html)
// Writes _preview/pin-probe.html and, with the two height-chain rules put back the way they
// were, _preview/pin-probe-before.html — the same page twice, so the two screenshots compare
// the scrollbar's seat. The alignment numbers are read from the first of the two: the second
// is the chain comparison only, and its own insets are the old, single-band ones.
import { readFileSync, writeFileSync } from "node:fs"

const html = readFileSync("_preview/panel.html", "utf8")
// The probe page owns the viewport: the panel is a column of the shell's document, so it is
// only bounded — and only scrollable inside — when it is given the window as its seat, which
// is what the shell does and what its own `height: 100%` cannot do inside a loose wrapper.
const bound = `<style>html, body { height: 100vh; margin: 0; overflow: hidden; } .dws-panel { height: 100vh !important; }</style>`
const script = `
<script>
  addEventListener("load", () => {
    setTimeout(() => {
      const list = document.querySelector(".dws-list-body")
      const frame = document.querySelector(".dws-panel-scroll")
      const heading = document.querySelector(".dws-panel-heading")
      const tab = document.querySelector(".dws-panel-body .dws-nav .dws-nav-item")
      const toolbar = document.querySelector(".dws-toolbar")
      list.scrollTop = list.scrollHeight
      const top = (el) => Math.round(el.getBoundingClientRect().top)
      const line = (name, el) => name + "=" + Math.round(el.clientHeight) + " box, " + Math.round(el.scrollHeight) + " content, at " + Math.round(el.scrollTop) + (el.scrollHeight > el.clientHeight ? " SCROLLS" : " fits")
      const out = document.createElement("div")
      out.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9;background:#111;color:#fff;font:15px monospace;padding:6px;line-height:20px"
      out.innerHTML = [
        line("list ", list),
        line("frame", frame),
        "headingTop=" + top(heading) + " viewport=" + innerHeight,
        "tabTop=" + top(tab) + " toolbarTop=" + top(toolbar) + " tabTop-toolbarTop=" + (top(tab) - top(toolbar)),
      ].join("<br>")
      document.body.append(out)
    }, 400)
  })
</script>`

const before = html
  .replace(/\.dws-panel-scroll \{[^}]*\}/, ".dws-panel-scroll { flex: 1; min-width: 0; min-height: 0; overflow: auto; }")
  .replace(/\.dws-panel-content \{[^}]*\}/, ".dws-panel-content { display: flex; flex-direction: column; min-height: 0; max-width: 960px; padding: 28px 32px 48px 24px; }")

if (before === html) throw new Error("the two rules were not found in _preview/panel.html")
const page = (source) => source.replace("</head>", bound + "</head>").replace("</body>", script + "</body>")
writeFileSync("_preview/pin-probe.html", page(html))
writeFileSync("_preview/pin-probe-before.html", page(before))
console.log("wrote _preview/pin-probe.html and _preview/pin-probe-before.html")
